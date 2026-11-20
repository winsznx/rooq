import { afterAll, afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { amountOut } from "@rooq/private-sdk";
import { createLogger } from "../../src/lib/log";
import { RateLimiter, startHttpServer } from "../../src/lib/http";
import { forwardQuote, QUOTE_POOL_BUDGET_SCOPE, type QuoteFetch } from "../../src/lib/quote-proxy";
import { coarseImpactBps, quoteRoute } from "../../src/lib/spot-exec";

const ASSET = `0x${"11".repeat(20)}`;

function stubSpot(touched: bigint[], known: (id: bigint) => boolean = () => true): Parameters<typeof quoteRoute>[0] {
  return {
    hasPool: known,
    quote: (first: bigint, second: bigint) => {
      touched.push(first, ...(second !== 0n ? [second] : []));
      return { amountOut: 1n, priceImpactBps: 0, hops: second !== 0n ? 2 : 1 };
    },
  };
}

const post = (body: unknown): Request => new Request("http://x/v1/spot/quote", { method: "POST", body: JSON.stringify(body) });

describe("per-pool quote budget (audit #23)", () => {
  test("a routed quote is charged to its second pool too", async () => {
    const touched: bigint[] = [];
    const route = quoteRoute(stubSpot(touched));
    const call = (body: unknown): Promise<Response> => Promise.resolve(route.handler({ req: post(body), url: new URL("http://x/v1/spot/quote"), params: {} }));
    for (let i = 0; i < 240; i++) expect((await call({ pool: "2", amountIn: "1000", assetIn: ASSET })).status).toBe(200);
    const routed = call({ pool: "1", secondPool: "2", amountIn: "1000", assetIn: ASSET });
    await expect(routed).rejects.toMatchObject({ statusCode: 429, details: { scope: QUOTE_POOL_BUDGET_SCOPE } });
    expect(touched.filter((p) => p === 2n).length).toBe(240);
  });

  test("a refused routed quote charges neither pool", async () => {
    const route = quoteRoute(stubSpot([]));
    const call = (body: unknown): Promise<Response> => Promise.resolve(route.handler({ req: post(body), url: new URL("http://x/v1/spot/quote"), params: {} }));
    for (let i = 0; i < 240; i++) await call({ pool: "2", amountIn: "1000", assetIn: ASSET });
    for (let i = 0; i < 10; i++) await call({ pool: "1", secondPool: "2", amountIn: "1000", assetIn: ASSET }).catch(() => null);
    for (let i = 0; i < 240; i++) expect((await call({ pool: "1", amountIn: "1000", assetIn: ASSET })).status).toBe(200);
  });
});

describe("per-pool quote budget keys (re-audit)", () => {
  afterEach(() => setSystemTime());

  test("an unknown pool is refused before the budget, so caller-chosen ids add no entries", async () => {
    const charged = spyOn(RateLimiter.prototype, "allowEach");
    try {
      const route = quoteRoute(stubSpot([], (id) => id === 1n));
      for (let i = 0; i < 500; i++) {
        const body = { pool: String(10n ** 30n + BigInt(i)), secondPool: String(10n ** 35n + BigInt(i)), amountIn: "1", assetIn: ASSET };
        await expect(Promise.resolve(route.handler({ req: post(body), url: new URL("http://x/v1/spot/quote"), params: {} }))).rejects.toMatchObject({ statusCode: 422, reasonCode: "UNKNOWN_POOL" });
      }
      const routed = { pool: "1", secondPool: "999", amountIn: "1", assetIn: ASSET };
      await expect(Promise.resolve(route.handler({ req: post(routed), url: new URL("http://x/v1/spot/quote"), params: {} }))).rejects.toMatchObject({ reasonCode: "UNKNOWN_POOL" });
      expect(charged).not.toHaveBeenCalled();
    } finally {
      charged.mockRestore();
    }
  });

  test("the budget is pruned once a window has passed", async () => {
    const pruned = spyOn(RateLimiter.prototype, "prune");
    try {
      const start = new Date("2026-11-17T00:00:00Z");
      setSystemTime(start);
      const route = quoteRoute(stubSpot([]));
      const call = (): Promise<Response> => Promise.resolve(route.handler({ req: post({ pool: "2", amountIn: "1000", assetIn: ASSET }), url: new URL("http://x/v1/spot/quote"), params: {} }));
      await call();
      setSystemTime(new Date(start.getTime() + 30_000));
      await call();
      expect(pruned).not.toHaveBeenCalled();
      setSystemTime(new Date(start.getTime() + 61_000));
      await call();
      expect(pruned).toHaveBeenCalledTimes(1);
    } finally {
      pruned.mockRestore();
    }
  });
});

describe("quote price impact (audit #29)", () => {
  // Two pools whose reserves agree to four significant figures and differ after that.
  const a = { rIn: 123_456_789_012_345_678_901n, rOut: 98_765_432_109_876_543_210_987n, feeBps: 30n };
  const b = { rIn: 123_499_999_999_999_999_999n, rOut: 98_769_999_999_999_999_999_999n, feeBps: 30n };

  test("impact is the same for reserves that agree to four significant figures", () => {
    for (let i = 1n; i <= 400n; i++) {
      const amount = (a.rIn * i) / 200n + i * 7_919n;
      expect(coarseImpactBps([b], amount)).toBe(coarseImpactBps([a], amount));
    }
  });

  test("the 50% edge no longer pins the exact reserve", () => {
    let lo = 1n;
    let hi = a.rIn * 4n;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (coarseImpactBps([a], mid) >= 5_000) hi = mid;
      else lo = mid + 1n;
    }
    const estimate = (500_001n * lo * 9_970n) / (10_000n * 499_999n);
    expect(estimate).not.toBe(a.rIn);
    expect(estimate.toString().slice(0, 4)).toBe("1234");
  });

  test("still reports a 1 percent order at about 100 bps", () => {
    const pool = { rIn: 1_000_000n * 10n ** 18n, rOut: 400_000_000n * 10n ** 6n, feeBps: 30n };
    const bps = coarseImpactBps([pool], pool.rIn / 100n);
    expect(bps).toBeGreaterThanOrEqual(90);
    expect(bps).toBeLessThanOrEqual(110);
  });

  test("chains hops through the coarse reserves", () => {
    const mid = { rIn: 5_000_000n, rOut: 7_000_000n, feeBps: 30n };
    const one = coarseImpactBps([a], 10n ** 18n);
    const two = coarseImpactBps([a, mid], 10n ** 18n);
    expect(two).toBeGreaterThan(one);
    expect(amountOut(10n ** 18n, a.rIn, a.rOut, 30n)).toBeGreaterThan(0n);
  });
});

describe("read API quote forwarding (audit #11)", () => {
  const ok = (body: Record<string, unknown>): Response => new Response(JSON.stringify(body), { status: 200 });
  const limited = (scope?: string): Response => new Response(JSON.stringify({ reasonCode: "RATE_LIMITED", ...(scope ? { details: { scope } } : {}) }), { status: 429 });

  test("names the caller to the keyed service", async () => {
    const seen: (string | null)[] = [];
    const fetcher: QuoteFetch = (_url, init) => {
      seen.push(new Headers(init.headers).get("x-forwarded-for"));
      return Promise.resolve(ok({ amountOut: "1" }));
    };
    await forwardQuote(["http://c"], "{}", "9.9.9.9", fetcher);
    expect(seen).toEqual(["9.9.9.9"]);
  });

  test("a per-client 429 falls through to the next service, labelled as a fallback", async () => {
    const urls: string[] = [];
    const fetcher: QuoteFetch = (url) => {
      urls.push(url);
      return Promise.resolve(url.startsWith("http://c/") ? limited() : ok({ amountOut: "5", indicative: true }));
    };
    const res = await forwardQuote(["http://c", "http://a"], "{}", "1.1.1.1", fetcher);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ amountOut: "5", indicative: true, fallback: true });
    expect(urls).toEqual(["http://c/v1/spot/quote", "http://a/v1/spot/quote"]);
  });

  test("a spent pool budget is final, so another service can't widen it", async () => {
    let calls = 0;
    const fetcher: QuoteFetch = () => {
      calls++;
      return Promise.resolve(limited(QUOTE_POOL_BUDGET_SCOPE));
    };
    expect((await forwardQuote(["http://c", "http://a"], "{}", "1.1.1.1", fetcher)).status).toBe(429);
    expect(calls).toBe(1);
  });

  test("when every service is limited the 429 comes back, and when none answers it is QUOTE_UNAVAILABLE", async () => {
    expect((await forwardQuote(["http://c", "http://a"], "{}", undefined, () => Promise.resolve(limited()))).status).toBe(429);
    await expect(forwardQuote(["http://c"], "{}", undefined, () => Promise.reject(new Error("down")))).rejects.toMatchObject({ reasonCode: "QUOTE_UNAVAILABLE" });
  });

  describe("end to end through the coordinator's HTTP limiter", () => {
    const port = 39_000 + Math.floor(Math.random() * 2_000);
    const server = startHttpServer({ name: "coordinator-test", port, hostname: "127.0.0.1", allowedOrigins: [], routes: [quoteRoute(stubSpot([]))], log: createLogger("coordinator-test"), trustProxy: true });
    afterAll(() => server.stop());

    test("eight users quoting four times each are not limited as one client", async () => {
      const body = JSON.stringify({ pool: "1", amountIn: "1000", assetIn: ASSET });
      const statuses: number[] = [];
      for (let user = 0; user < 8; user++) {
        for (let i = 0; i < 4; i++) statuses.push((await forwardQuote([`http://127.0.0.1:${port}`], body, `10.0.0.${user}`)).status);
      }
      expect(statuses.every((s) => s === 200)).toBe(true);
    });
  });
});
