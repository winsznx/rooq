import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { routePattern } from "@rooq/private-sdk/admin";
import { REPO_ROOT } from "../../src/lib/config";
import { AnalyticsStore } from "../../src/lib/analytics-store";
import { pageviewRoute } from "../../src/lib/analytics-routes";
import { beaconCors, beaconOrigins, parseBeacon } from "../../src/lib/analytics-traffic";
import { ServiceError } from "../../src/lib/errors";

const beacon = { site: "web", route: "/app/perps", ref: null, device: "desktop", first: true };

const rejects = (body: Record<string, unknown>): ServiceError | null => {
  try {
    parseBeacon(body);
    return null;
  } catch (error) {
    return error instanceof ServiceError ? error : null;
  }
};

describe("beacon validation", () => {
  test("accepts a beacon whose route is a known pattern", () => {
    expect(parseBeacon(beacon)).toEqual({ site: "web", route: "/app/perps", ref: null, device: "desktop", first: true });
  });

  test("a concrete path with an account id collapses to its pattern, and only the pattern is accepted", () => {
    const route = routePattern("web", "/app/positions/12345/7?tab=history#x");
    expect(route).toBe("/app/positions/[account]/[market]");
    expect(parseBeacon({ ...beacon, route }).route).toBe(route);
    expect(rejects({ ...beacon, route: "/app/positions/12345/7" })?.statusCode).toBe(400);
  });

  test("an unknown path collapses to /other, which is accepted for each site", () => {
    expect(routePattern("docs", "/a/b/c")).toBe("/other");
    expect(parseBeacon({ ...beacon, site: "docs", route: "/other" }).route).toBe("/other");
  });

  test("every web page has its own pattern, so no real page is counted as /other", () => {
    const pages = [...new Glob("**/page.tsx").scanSync(`${REPO_ROOT}apps/web/app`)]
      .map((file) => `/${file.replace(/(^|\/)page\.tsx$/, "")}`)
      .filter((path) => path !== "/admin" && !path.startsWith("/admin/"));
    expect(pages.length).toBeGreaterThan(10);
    const unmatched = pages.filter((path) => routePattern("web", path.replace(/\[[^\]]+\]/g, "1")) === "/other");
    expect(unmatched).toEqual([]);
  });

  test("a route valid on one site is refused on another", () => {
    expect(rejects({ ...beacon, site: "docs", route: "/app/perps" })?.reasonCode).toBe("INVALID_REQUEST");
  });

  test("refuses any field beyond the five, so nothing identifying can ride along", () => {
    expect(rejects({ ...beacon, id: "abc" })?.message).toContain("Unknown beacon field");
  });

  test("ref must be a bare lowercase host; a leading www. is dropped", () => {
    expect(parseBeacon({ ...beacon, ref: "www.x.com" }).ref).toBe("x.com");
    expect(rejects({ ...beacon, ref: "https://x.com/path" })).not.toBeNull();
    expect(rejects({ ...beacon, ref: "X.com" })).not.toBeNull();
    expect(rejects({ ...beacon, ref: "a".repeat(65) })).not.toBeNull();
  });

  test("refuses an unknown site or device and a non-boolean first", () => {
    expect(rejects({ ...beacon, site: "blog" })).not.toBeNull();
    expect(rejects({ ...beacon, device: "watch" })).not.toBeNull();
    expect(rejects({ ...beacon, first: "yes" })).not.toBeNull();
    expect(parseBeacon({ ...beacon, first: null }).first).toBeNull();
  });
});

describe("beacon CORS", () => {
  const origins = beaconOrigins(["https://rooq.trade"], ["https://docs.rooq.trade/", " "]);

  test("allows the web and docs origins only", () => {
    expect(beaconCors("https://docs.rooq.trade", origins)["access-control-allow-origin"]).toBe("https://docs.rooq.trade");
    expect(beaconCors("https://rooq.trade", origins)["access-control-allow-origin"]).toBe("https://rooq.trade");
    expect(beaconCors("https://evil.example", origins)).toEqual({});
    expect(beaconCors(null, origins)).toEqual({});
  });
});

describe("POST /v1/pv", () => {
  const HOUR = 1_800_000_000 - (1_800_000_000 % 3_600);
  const post = (body: string, origin = "https://docs.rooq.trade"): Request =>
    new Request("http://x/v1/pv", { method: "POST", body, headers: { "content-type": "text/plain;charset=UTF-8", origin, "x-forwarded-for": "203.0.113.9", "user-agent": "Test/1.0" } });

  test("aggregates by hour and dimensions, counting a visit only on the day's first view", async () => {
    const store = new AnalyticsStore(":memory:");
    let counted = 0;
    const route = pageviewRoute(store, beaconOrigins([], ["https://docs.rooq.trade"]), () => counted++, () => HOUR + 120);
    const send = (b: Record<string, unknown>): Promise<Response> => Promise.resolve(route.handler({ req: post(JSON.stringify(b)), url: new URL("http://x/v1/pv"), params: {} }));
    const first = await send({ ...beacon, site: "docs", route: "/[page]", ref: "x.com" });
    await send({ ...beacon, site: "docs", route: "/[page]", ref: "x.com", first: false });
    await send({ ...beacon, site: "docs", route: "/[page]", ref: "x.com", first: null });
    expect(first.status).toBe(204);
    expect(first.headers.get("access-control-allow-origin")).toBe("https://docs.rooq.trade");
    expect(counted).toBe(3);
    expect(store.pageviewTotals(0, "route")).toEqual([{ key: "docs:/[page]", views: 3, visits: 1 }]);
    expect(store.pageviewTotals(0, "referrer")).toEqual([{ key: "x.com", views: 3, visits: 1 }]);
    expect(store.pageviewSeries(0, 3_600)).toEqual([{ t: HOUR, views: 3, visits: 1 }]);
    store.close();
  });

  test("stores nothing from the request beyond the beacon fields", async () => {
    const store = new AnalyticsStore(":memory:");
    const route = pageviewRoute(store, new Set(), () => undefined, () => HOUR);
    await route.handler({ req: post(JSON.stringify(beacon)), url: new URL("http://x/v1/pv"), params: {} });
    const dump = JSON.stringify([store.pageviewTotals(0, "route"), store.pageviewTotals(0, "referrer"), store.pageviewTotals(0, "device"), store.pageviewTotals(0, "site")]);
    expect(dump).not.toContain("203.0.113.9");
    expect(dump).not.toContain("Test/1.0");
    expect(store.pageviewTotals(0, "referrer")).toEqual([{ key: "direct", views: 1, visits: 1 }]);
    store.close();
  });

  test("refuses a body over 2048 bytes", async () => {
    const store = new AnalyticsStore(":memory:");
    const route = pageviewRoute(store, new Set(), () => undefined);
    const big = JSON.stringify({ ...beacon, pad: "x".repeat(2_100) });
    await expect(Promise.resolve(route.handler({ req: post(big), url: new URL("http://x/v1/pv"), params: {} }))).rejects.toMatchObject({ statusCode: 413 });
    store.close();
  });
});
