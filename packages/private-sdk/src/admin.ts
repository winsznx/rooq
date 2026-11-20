/**
 * Contract between the analytics service (apps/private-services) and the owner-only admin area (apps/web/app/admin).
 * Everything here is public chain data or aggregate counts. Nothing decrypted by a service, no per-user trade data,
 * and no browsable list of user addresses (ADR-P01, D-06).
 */

export const ADMIN_RANGES = ["24h", "7d", "30d", "all"] as const;
export type AdminRange = (typeof ADMIN_RANGES)[number];

export const ADMIN_BUCKETS = ["hour", "day"] as const;
export type AdminBucket = (typeof ADMIN_BUCKETS)[number];

export type TxCategory = "user" | "maintenance" | "oracle";
export type DeviceClass = "mobile" | "tablet" | "desktop";

/** One point in a time series. `t` is the bucket start in unix seconds. */
export interface SeriesPoint {
  t: number;
  v: number;
}

export interface AdminIndexerState {
  /** Last block fully indexed, at head minus the finality margin. */
  indexedBlock: number;
  head: number;
  lagBlocks: number;
  updatedAt: number;
  backfilling: boolean;
}

export interface AdminOverview {
  range: AdminRange;
  indexer: AdminIndexerState;
  wallets: { total: number; newInRange: number };
  shields: { count: number; byAsset: AssetAmount[] };
  unshields: { count: number; byAsset: AssetAmount[]; relayerFees: AssetAmount[] };
  /** `reverted` is always 0: a reverted transaction emits no protocol log, so the index never sees it. */
  txs: { user: number; maintenance: number; oracle: number; reverted: number };
  operatorGasWei: string;
  traffic: { views: number; visits: number };
  services: { ok: number; degraded: number; down: number };
}

export interface AssetAmount {
  asset: `0x${string}`;
  symbol: string;
  decimals: number;
  /** False until the token's decimals have been read from chain; `decimals` is then 0 and `symbol` the address. */
  decimalsKnown: boolean;
  /** Base units as a decimal string. */
  amount: string;
}

export interface AdminActionRow {
  action: string;
  category: TxCategory;
  count: number;
  /** Always 0, as for `AdminOverview.txs.reverted`. Operator failures show as `AdminOperator.unindexedTxs`. */
  reverted: number;
}

export interface AdminActions {
  range: AdminRange;
  bucket: AdminBucket;
  rows: AdminActionRow[];
  series: { user: SeriesPoint[]; maintenance: SeriesPoint[]; oracle: SeriesPoint[] };
}

export interface AdminFlows {
  range: AdminRange;
  bucket: AdminBucket;
  shields: AdminFlowSeries[];
  unshields: AdminFlowSeries[];
}

export interface AdminFlowSeries {
  asset: `0x${string}`;
  symbol: string;
  decimals: number;
  /** As for `AssetAmount.decimalsKnown`: false means `amount` points are raw base units. */
  decimalsKnown: boolean;
  count: SeriesPoint[];
  amount: SeriesPoint[];
}

/** Counts only. Addresses are never returned. */
export interface AdminWallets {
  range: AdminRange;
  bucket: AdminBucket;
  total: number;
  newInRange: number;
  newPerBucket: SeriesPoint[];
  cumulative: SeriesPoint[];
  bySource: { source: WalletSource; count: number }[];
}
export type WalletSource = "shield" | "unshield" | "market" | "direct";

export interface AdminOperator {
  label: string;
  address: `0x${string}`;
  balanceWei: string;
  /** Read at the indexed block, so it covers the same blocks as `indexedTxs`. 0 until the first read after backfill. */
  nonce: number;
  indexedTxs: number;
  /** Nonce minus indexed txs: txs that emitted no protocol log (reverts, approvals, transfers, deployments). */
  unindexedTxs: number;
  gasSpentWei: string;
  lastTxAt: number | null;
  actions: { action: string; count: number }[];
}

export interface AdminOperators {
  range: AdminRange;
  operators: AdminOperator[];
}

export type ServiceState = "ok" | "degraded" | "down";
export interface AdminService {
  name: string;
  state: ServiceState;
  /** The service's own /health body, passed through unchanged. Null when unreachable. */
  health: Record<string, unknown> | null;
  latencyMs: number | null;
  error: string | null;
}
export interface AdminServices {
  checkedAt: number;
  services: AdminService[];
}

export interface AdminMarket {
  id: number;
  symbol: string;
  feed: `0x${string}`;
  lastPriceAt: number | null;
  priceUpdatesInRange: number;
  opened: number;
  closed: number;
  liquidated: number;
}
export interface AdminPool {
  id: number;
  symbol: string;
  updatesInRange: number;
}
export interface AdminMarkets {
  range: AdminRange;
  markets: AdminMarket[];
  pools: AdminPool[];
  marketsCreated: number;
}

export interface AdminTrafficRow {
  key: string;
  views: number;
  visits: number;
}
export interface AdminTraffic {
  range: AdminRange;
  bucket: AdminBucket;
  views: SeriesPoint[];
  visits: SeriesPoint[];
  routes: AdminTrafficRow[];
  referrers: AdminTrafficRow[];
  devices: AdminTrafficRow[];
  sites: AdminTrafficRow[];
}

/** Sites that send pageviews. */
export const PV_SITES = ["web", "docs"] as const;
export type PvSite = (typeof PV_SITES)[number];

/** Body of POST /v1/pv. Route is a pattern, never a raw path. */
export interface PageviewBeacon {
  site: PvSite;
  route: string;
  /** Cross-site referrer host only, e.g. "x.com". Null for direct or same-site. */
  ref: string | null;
  device: DeviceClass;
  /** True on the first pageview of a UTC day in this browser; null when the browser keeps no storage. */
  first: boolean | null;
}

/**
 * Route patterns the beacon may report. A path that matches none is reported as "/other", so ids, queries
 * and hashes never leave the browser. Segments in brackets match one path segment.
 */
export const PV_ROUTES: Record<PvSite, readonly string[]> = {
  web: [
    "/",
    "/how-it-works",
    "/learn",
    "/developers",
    "/docs",
    "/status",
    "/inspect",
    "/app",
    "/app/spot",
    "/app/perps",
    "/app/perps/[market]",
    "/app/liquidity",
    "/app/funds",
    "/app/activity",
    "/app/makers",
    "/app/markets",
    "/app/markets/[market]",
    "/app/positions",
    "/app/positions/[account]",
    "/app/positions/[account]/[market]",
    "/app/settings",
    "/app/trade",
    "/app/trade/[market]",
    "/app/swap",
    "/app/portfolio",
    "/app/liquidity/[pool]",
    "/app/makers/[market]",
    "/app/assets/[chain]/[address]",
    "/app/create",
    "/app/create/asset",
    "/app/create/leverage",
    "/app/create/liquidity",
    "/app/create/preflight",
    "/app/create/review",
    "/app/create/success",
    "/other",
  ],
  docs: ["/", "/[page]", "/other"],
};

/** Collapse a pathname to its reporting pattern. Pure and shared by the beacon and the server check. */
export function routePattern(site: PvSite, pathname: string): string {
  const parts = pathname.split(/[?#]/, 1)[0]!.split("/").filter(Boolean);
  const path = `/${parts.join("/")}`;
  for (const pattern of PV_ROUTES[site]) {
    if (pattern === "/other") continue;
    const want = pattern.split("/").filter(Boolean);
    if (want.length !== parts.length) continue;
    if (want.every((seg, i) => (seg.startsWith("[") && seg.endsWith("]")) || seg === parts[i])) return pattern;
  }
  return path === "/" ? "/" : "/other";
}

export function isAllowedRoute(site: PvSite, route: string): boolean {
  return PV_ROUTES[site].includes(route);
}

/** Referrer host reduced to a registrable-looking host, lowercased, at most 64 chars. */
export function referrerHost(referrer: string, ownHosts: readonly string[]): string | null {
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
    if (!host || ownHosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
    return host.slice(0, 64);
  } catch {
    return null;
  }
}

/* ---- Additions: money in USD, vault, fees, people, actions by kind, and the $ROOQ mainnet token. ---- */

/**
 * Shield and unshield value in USD. USDG counts as $1; Stock Tokens are valued at their testnet oracle answer for the
 * hour of the event (the latest answer at or before it). `unpriced` counts events whose asset had no price yet.
 */
export interface AdminMoney {
  range: AdminRange;
  bucket: AdminBucket;
  totals: {
    allTimeUsd: number;
    inRangeUsd: number;
    last24hUsd: number;
    last7dUsd: number;
    inUsd: number;
    outUsd: number;
    /** Change of in-range volume against the previous window of the same length. Null for "all" or no prior data. */
    changePct: number | null;
  };
  series: { in: SeriesPoint[]; out: SeriesPoint[] };
  byAsset: (AssetAmount & { direction: "in" | "out"; usd: number })[];
  unpriced: number;
}

/** What the custody contract holds right now: public ERC-20 balances, priced at the latest oracle answer. */
export interface AdminVault {
  asOf: number;
  totalUsd: number;
  assets: (AssetAmount & { usd: number | null; sharePct: number })[];
}

export interface AdminFees {
  range: AdminRange;
  bucket: AdminBucket;
  /** Relayer fees taken from unshields (Unshielded.fee). */
  relayerFees: (AssetAmount & { usd: number | null })[];
  relayerFeesUsd: number;
  relayerFeesSeries: SeriesPoint[];
  /** Gas the relayer wallet spent in range, so fees can be read against cost. */
  relayerGasWei: string;
  operatorGasWei: string;
  operatorGasSeries: SeriesPoint[];
}

/** Counts of public wallets only (shield senders, unshield recipients, market creators, direct senders). Never addresses. */
export interface AdminPeople {
  range: AdminRange;
  bucket: AdminBucket;
  active: SeriesPoint[];
  activeInRange: number;
  newInRange: number;
  returningInRange: number;
  /** Shielded at some point and never unshielded to any address. */
  stillShielded: number;
}

export interface AdminActionSeries {
  action: string;
  category: TxCategory;
  series: SeriesPoint[];
}

/** User-intent actions by kind per bucket, for the stacked bar on the overview. */
export interface AdminKinds {
  range: AdminRange;
  bucket: AdminBucket;
  kinds: AdminActionSeries[];
}

/** $ROOQ on Robinhood Chain mainnet (4663): the Pons-launched token, its Uniswap v4 pool and the creator's fees. */
export interface AdminToken {
  asOf: number;
  token: `0x${string}`;
  priceUsd: number | null;
  priceEth: number | null;
  marketCapUsd: number | null;
  ethUsd: number | null;
  poolEth: number | null;
  window: {
    range: AdminRange;
    volumeUsd: number;
    buys: number;
    sells: number;
    buyUsd: number;
    sellUsd: number;
    uniqueTraders: number;
  };
  holders: number | null;
  creatorFees: {
    /** Native ETH credited to the creator in the Pons fee escrow and not yet claimed. */
    pendingEth: number | null;
    /** ROOQ-denominated fees still waiting for the Pons operator sweep. */
    pendingRooq: number | null;
    /** Estimated lifetime creator take: in-pool volume times the creator rate (0.7% hook share + creator tax). */
    estimatedLifetimeUsd: number | null;
    rateBps: number;
  };
  series: { price: SeriesPoint[]; volume: SeriesPoint[]; buys: SeriesPoint[]; sells: SeriesPoint[] };
  indexer: AdminIndexerState;
}

export const ADMIN_SLICES = ["overview", "actions", "flows", "wallets", "operators", "services", "markets", "traffic", "money", "vault", "fees", "people", "kinds", "token"] as const;
export type AdminSliceName = (typeof ADMIN_SLICES)[number];
