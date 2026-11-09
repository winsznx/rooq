/**
 * Wire contract between apps/api and its consumers (apps/web, keepers, integrators).
 * Rules (03-ENGINEERING/API_AND_EVENTS.md): money and token amounts are decimal integer strings in the
 * asset's smallest unit, never floats; every snapshot carries the block it was read at; addresses are
 * EIP-55 checksummed; nothing here is authoritative over the contracts.
 */

export type DecimalString = string;
export type HexString = `0x${string}`;

export interface BlockAnchor {
  readonly chainId: number;
  readonly blockNumber: DecimalString;
  readonly blockTimestamp: number;
}

export interface ApiErrorBody {
  readonly statusCode: number;
  readonly reasonCode: string;
  readonly message: string;
  readonly canRetry: boolean;
  readonly requestId: string;
  readonly details?: unknown;
}

export interface OracleView {
  readonly feedId: HexString;
  readonly feed: HexString;
  /** 18-decimal USD per base unit; null when unreadable. */
  readonly price: DecimalString | null;
  readonly updatedAt: number | null;
  readonly ageSeconds: number | null;
  readonly heartbeatSeconds: number;
  readonly fresh: boolean;
  /** Human label of the source, e.g. "TEST relay of api.robinhood.com/rhj/prices". */
  readonly source: string;
  readonly isTestFeed: boolean;
}

export interface RiskView {
  readonly tierId: number;
  readonly tierName: string;
  readonly imrWad: DecimalString;
  readonly mmrWad: DecimalString;
  /** Max leverage in tenths, derived as floor(10 / imr). 20 = 2.0x. */
  readonly maxLeverageTenths: number;
  readonly maxOiUsdWad: DecimalString;
  readonly takerFeeBps: number;
  readonly makerFeeBps: number;
  readonly liqPenaltyBps: number;
  readonly maxDeviationBps: number;
  readonly maxFundingRatePerHourWad: DecimalString;
  readonly minMakerBacking: DecimalString;
  readonly minBond: DecimalString;
  readonly version: number;
}

export interface SpotView {
  readonly pool: HexString;
  readonly status: "NONE" | "ACTIVE" | "PAUSED";
  readonly feeBps: number;
  readonly token0: HexString;
  readonly token1: HexString;
  readonly reserve0: DecimalString;
  readonly reserve1: DecimalString;
  readonly lpSupply: DecimalString;
  /** Pool marginal price in 18-decimal quote per base; null if unfunded. */
  readonly poolPrice: DecimalString | null;
  readonly feesAccrued0: DecimalString;
  readonly feesAccrued1: DecimalString;
}

export interface PerpView {
  readonly status: "NONE" | "REGISTERED" | "ACTIVE" | "CLOSE_ONLY" | "PAUSED" | "SETTLEMENT_PENDING" | "SETTLED";
  /** ACTIVE with a stale feed is reported as effective CLOSE_ONLY for the UI. */
  readonly effectiveStatus: PerpView["status"];
  readonly longOi: DecimalString;
  readonly shortOi: DecimalString;
  /** OI notional at the current mark, 18-decimal USD. */
  readonly oiUsdWad: DecimalString | null;
  readonly makerBacking: DecimalString;
  readonly badDebt: DecimalString;
  readonly fundingRatePerSecondWad: DecimalString;
  readonly fundingIndex: DecimalString;
  readonly lastFundingTime: number;
  readonly insurance: DecimalString;
  readonly creatorBond: DecimalString;
  readonly risk: RiskView | null;
  readonly oracle: OracleView | null;
}

export interface AssetView {
  readonly address: HexString;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly assetClass: "stock-token" | "stablecoin" | "crypto" | "test-fixture";
  /** True only for canonical third-party assets whose identity was verified (packages/config/src/tokens.ts). */
  readonly verified: boolean;
  readonly verificationSource: string | null;
  readonly logoUrl: string | null;
  readonly isTestFixture: boolean;
}

export interface MarketSummary {
  readonly marketId: HexString;
  readonly key: string;
  readonly base: AssetView;
  readonly quote: AssetView;
  readonly creator: HexString;
  readonly createdAt: number;
  readonly spot: SpotView;
  readonly perp: PerpView;
  /** 24h change from indexed executed trades only; null when there were no trades. */
  readonly change24hWad: DecimalString | null;
  readonly volume24hQuote: DecimalString | null;
  /**
   * apps/api fills change24hWad and volume24hQuote from spot pool swaps only, so one price process is
   * never mixed with another. These two carry the same figures for perp fills.
   */
  readonly perpChange24hWad?: DecimalString | null;
  readonly perpVolume24hQuote?: DecimalString | null;
  readonly anchor: BlockAnchor;
}

export interface MarketsResponse {
  readonly markets: readonly MarketSummary[];
  readonly anchor: BlockAnchor;
  readonly indexer: IndexerHealth;
  readonly nextCursor?: string | null;
}

export interface Candle {
  readonly t: number;
  readonly o: DecimalString;
  readonly h: DecimalString;
  readonly l: DecimalString;
  readonly c: DecimalString;
  readonly v: DecimalString;
}

export interface ChartResponse {
  readonly marketId: HexString;
  readonly interval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
  /** Executed Rooq trades only. "pool" = spot swaps, "perp" = perp fills, "oracle" = feed observations. */
  readonly series: { readonly source: "pool" | "perp" | "oracle"; readonly unit: "USD_PER_BASE"; readonly candles: readonly Candle[] }[];
  readonly anchor: BlockAnchor;
  readonly indexer?: IndexerHealth;
}

export interface TradeRow {
  readonly kind: "perp" | "swap";
  readonly txHash: HexString;
  readonly logIndex: number;
  readonly blockNumber: DecimalString;
  readonly timestamp: number;
  readonly account: HexString;
  /** Signed base size (perp) or base amount bought(+)/sold(-) (swap), 18 decimals. */
  readonly size: DecimalString;
  readonly price: DecimalString;
  readonly fee: DecimalString;
  readonly canonical: boolean;
  /** Token `fee` is denominated in: collateral for perp fills, the input token for swaps. */
  readonly feeToken?: HexString;
}

export interface PositionView {
  readonly marketId: HexString;
  readonly taker: HexString;
  readonly maker: HexString;
  readonly size: DecimalString;
  readonly entryPrice: DecimalString;
  readonly takerMargin: DecimalString;
  readonly makerMargin: DecimalString;
  readonly realizedPnl: DecimalString;
  readonly takerEquity: DecimalString | null;
  readonly initialMargin: DecimalString | null;
  readonly maintenanceMargin: DecimalString | null;
  readonly pendingFunding: DecimalString | null;
  readonly markPrice: DecimalString | null;
  readonly markFresh: boolean;
  readonly estLiquidationPrice: DecimalString | null;
  readonly liquidatable: boolean;
}

export interface LpView {
  readonly marketId: HexString;
  readonly pool: HexString;
  readonly shares: DecimalString;
  readonly lpSupply: DecimalString;
  readonly amount0: DecimalString;
  readonly amount1: DecimalString;
}

export interface AccountResponse {
  readonly wallet: HexString;
  readonly collateral: { readonly token: HexString; readonly symbol: string; readonly decimals: number; readonly wallet: DecimalString; readonly vaultFree: DecimalString; readonly vaultLocked: DecimalString };
  readonly positions: readonly PositionView[];
  readonly lp: readonly LpView[];
  readonly holdings: readonly { readonly asset: AssetView; readonly balance: DecimalString }[];
  readonly anchor: BlockAnchor;
  readonly indexer: IndexerHealth;
}

export type TxState = "notSeen" | "pending" | "mined" | "reverted" | "rechecking";
export type FinalityTier = "local" | "sequencer" | "l1-pending" | "l1-final";

export interface ActivityRow {
  readonly txHash: HexString;
  readonly blockNumber: DecimalString;
  readonly timestamp: number;
  readonly action: string;
  readonly marketId: HexString | null;
  readonly summary: string;
  readonly state: TxState;
  readonly finality: FinalityTier;
  readonly canonical: boolean;
}

export interface ActivityResponse {
  readonly wallet: HexString;
  readonly items: readonly ActivityRow[];
  readonly nextCursor: string | null;
  readonly indexer: IndexerHealth;
}

export interface TransactionResponse {
  readonly hash: HexString;
  readonly state: TxState;
  readonly finality: FinalityTier;
  readonly blockNumber: DecimalString | null;
  readonly confirmations: number;
  readonly explorerUrl: string | null;
}

export interface SpotQuoteResponse {
  readonly path: readonly HexString[];
  readonly fees: readonly number[];
  readonly amountIn: DecimalString;
  readonly amountOut: DecimalString;
  readonly minOut: DecimalString;
  readonly priceImpactBps: number;
  readonly feeAmount: DecimalString;
  readonly route: "rooq-pool";
  readonly expiresAt: number;
  readonly anchor: BlockAnchor;
  /** Fee taken by each hop, in that hop's input token. `feeAmount` is the first hop's. */
  readonly hopFees?: readonly DecimalString[];
}

export interface PreflightCheck {
  readonly key: string;
  readonly label: string;
  readonly passed: boolean;
}

export interface PreflightResponse {
  readonly verdict: "READY" | "NEEDS_FEED" | "NEEDS_BACKING" | "BLOCKED";
  readonly mask: DecimalString;
  readonly checks: readonly PreflightCheck[];
  /** Preflight is a read. It reserves nothing and grants nothing; activatePerps rechecks onchain. */
  readonly notReserved: true;
  readonly anchor: BlockAnchor;
}

export interface IndexerHealth {
  readonly status: "ok" | "behind" | "degraded" | "down";
  readonly lastIndexedBlock: DecimalString | null;
  readonly headBlock: DecimalString | null;
  readonly lagBlocks: number | null;
  readonly lastReconciledBlock: DecimalString | null;
  readonly reason: string | null;
}

export interface HealthResponse {
  readonly version: string;
  readonly env: string;
  readonly chainId: number;
  readonly rpc: { readonly ok: boolean; readonly latencyMs: number | null; readonly headBlock: DecimalString | null };
  readonly indexer: IndexerHealth;
  readonly maker: { readonly ok: boolean; readonly status: string | null };
  readonly oracles: readonly { readonly marketId: HexString; readonly symbol: string; readonly fresh: boolean; readonly ageSeconds: number | null }[];
  readonly markets: readonly { readonly marketId: HexString; readonly symbol: string; readonly perpStatus: PerpView["status"]; readonly spotStatus: SpotView["status"] }[];
  readonly checkedAt: string;
}

/** Server-sent event envelope (API_AND_EVENTS.md "WebSocket / SSE v1"). */
export interface StreamEnvelope<T = unknown> {
  readonly type: "market.tick" | "pool.swap" | "perp.trade" | "position.changed" | "market.status" | "indexer.sync" | "tx.status";
  readonly chainId: number;
  readonly marketId: HexString | null;
  readonly blockNumber: DecimalString;
  readonly blockHash: HexString;
  readonly txHash: HexString | null;
  readonly logIndex: number | null;
  readonly eventId: string;
  readonly observedAt: string;
  readonly reverted: boolean;
  readonly payload: T;
  readonly schemaVersion: 1;
}

/** Request-level reason codes the API uses next to the shared error vocabulary. */
export type ApiRequestReasonCode = "INVALID_REQUEST" | "NOT_FOUND" | "RATE_LIMITED";

export interface TradesResponse {
  readonly trades: readonly TradeRow[];
  readonly nextCursor: string | null;
  readonly indexer: IndexerHealth;
}

export interface FeesResponse {
  readonly marketId: HexString;
  readonly takerFeeBps: number;
  readonly makerFeeBps: number;
  readonly poolFeeBps: number;
  readonly liqPenaltyBps: number;
  /** Unclaimed protocol fees in collateral units. The FEES ledger domain is shared by every market. */
  readonly protocolFeesAccrued: DecimalString;
  readonly anchor: BlockAnchor;
}

export interface MarketStatusDetail {
  readonly marketId: HexString;
  readonly symbol: string;
  readonly perpStatus: PerpView["status"];
  readonly effectiveStatus: PerpView["status"];
  readonly spotStatus: SpotView["status"];
  readonly oracleFresh: boolean | null;
  readonly oracleAgeSeconds: number | null;
  readonly heartbeatSeconds: number | null;
  /** Latest indexed StatusChanged for this market; null when unknown or the indexer is down. */
  readonly lastStatusChange: {
    readonly from: PerpView["status"];
    readonly to: PerpView["status"];
    readonly blockNumber: DecimalString;
    readonly txHash: HexString;
  } | null;
}

export interface StatusResponse extends HealthResponse {
  readonly marketStatus: readonly MarketStatusDetail[];
  readonly lastReconciliation: {
    readonly blockNumber: DecimalString;
    readonly ok: boolean;
    readonly checks: number;
    readonly mismatches: number;
    readonly error: string | null;
    readonly at: string;
  } | null;
  readonly lastReorg: {
    readonly commonAncestor: DecimalString;
    readonly depth: number;
    readonly orphanedEvents: number;
    readonly detectedAt: string;
  } | null;
}

export interface PerpQuoteRequest {
  readonly marketId: HexString;
  readonly taker: HexString;
  /** Taker-perspective signed base size, 18 decimals. */
  readonly size: DecimalString;
}

export interface SpotQuoteRequest {
  readonly path: readonly HexString[];
  readonly fees: readonly number[];
  readonly amountIn: DecimalString;
  readonly slippageBps: number;
}

/** Mirrors Types.PreflightInput. */
export interface PreflightRequest {
  readonly base: HexString;
  readonly quote: HexString;
  readonly feedId: HexString;
  readonly tierId: number;
  readonly plannedBacking: DecimalString;
  readonly plannedBond: DecimalString;
  readonly plannedSpotQuote: DecimalString;
}
