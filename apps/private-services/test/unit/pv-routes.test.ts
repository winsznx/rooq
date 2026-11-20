import { describe, expect, test } from "bun:test";
import { routePattern } from "@rooq/private-sdk/admin";
import { parseBeacon } from "../../src/lib/analytics-traffic";

describe("pageview routes", () => {
  test("the /inspect page is a known web route the beacon may report", () => {
    expect(routePattern("web", "/inspect")).toBe("/inspect");
    expect(parseBeacon({ site: "web", route: "/inspect", ref: null, device: "desktop", first: true }).route).toBe("/inspect");
  });
});
