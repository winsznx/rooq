import type { AdminSliceName } from "@rooq/private-sdk/admin";
import { json, readJson, type RequestContext, type Route } from "./http";
import { requireBearer } from "./analytics-auth";
import type { AdminReports } from "./analytics-report";
import { parseWindow, type Window } from "./analytics-series";
import { hourOf, type AnalyticsStore } from "./analytics-store";
import { BEACON_MAX_BYTES, BEACON_PER_MINUTE, beaconCors, parseBeacon } from "./analytics-traffic";

/** Only the web server calls these, a few times a minute per open admin tab. */
const ADMIN_PER_MINUTE = 120;

type AdminHandler = (w: Window) => unknown;

/**
 * GET /v1/admin/<slice>?range=&bucket=, each behind the bearer token. The token is checked before the query is parsed,
 * so an unauthenticated caller learns nothing about valid parameters.
 */
export function adminRoutes(reports: AdminReports, token: string, now: () => number = () => Math.floor(Date.now() / 1000)): Route[] {
  const slices: Record<AdminSliceName, AdminHandler> = {
    overview: (w) => reports.overview(w),
    actions: (w) => reports.actions(w),
    flows: (w) => reports.flows(w),
    wallets: (w) => reports.wallets(w),
    operators: (w) => reports.operators(w),
    services: () => reports.services(),
    markets: (w) => reports.markets(w),
    traffic: (w) => reports.traffic(w),
    money: (w) => reports.money(w),
    vault: () => reports.vault(),
    fees: (w) => reports.fees(w),
    people: (w) => reports.people(w),
    kinds: (w) => reports.kinds(w),
    token: (w) => reports.token(w),
  };
  return Object.entries(slices).map(([slice, build]) => ({
    method: "GET",
    pattern: `/v1/admin/${slice}`,
    perMinute: ADMIN_PER_MINUTE,
    handler: async ({ req, url }: RequestContext) => {
      requireBearer(req, token);
      return json(await build(parseWindow(url, now())));
    },
  }));
}

/**
 * POST /v1/pv: one cookieless pageview. Stores an hourly count by route pattern, referrer host and device class; never
 * the IP, the user agent or anything that tells two visitors apart. The rate limiter keys on the IP in memory for a minute.
 */
export function pageviewRoute(store: AnalyticsStore, origins: ReadonlySet<string>, counted: () => void, now: () => number = () => Math.floor(Date.now() / 1000)): Route {
  return {
    method: "POST",
    pattern: "/v1/pv",
    perMinute: BEACON_PER_MINUTE,
    handler: async ({ req }) => {
      const beacon = parseBeacon(await readJson(req, BEACON_MAX_BYTES));
      store.recordPageview({ hour: hourOf(now()), site: beacon.site, route: beacon.route, referrerHost: beacon.ref, device: beacon.device, visit: beacon.first === true });
      counted();
      return new Response(null, { status: 204, headers: { "cache-control": "no-store", ...beaconCors(req.headers.get("origin"), origins) } });
    },
  };
}
