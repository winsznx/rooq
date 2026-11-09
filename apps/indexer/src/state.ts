import type { Address, Hex } from "viem";
import type { PerpStatus, SpotStatus } from "@rooq/sdk";
import type { LogPosition } from "./decode";

/**
 * Derived state is a pure function of the canonical event sequence. Every record is immutable: a
 * reducer returns a new record and the dispatcher swaps it into the map, so a shallow copy of the
 * maps is a complete, independent snapshot.
 */
export interface MarketState {
  readonly marketId: Hex;
  readonly base: Address;
  readonly quote: Address;
  readonly creator: Address;
  readonly pool: Address;
  readonly spotStatus: SpotStatus;
  readonly perpStatus: PerpStatus;
  readonly tierId: number | null;
  readonly feedId: Hex | null;
  readonly maxOiUsdWad: bigint | null;
  readonly imrWad: bigint | null;
  readonly riskVersion: number | null;
  readonly fundingIndex: bigint;
  readonly fundingRatePerSecond: bigint | null;
  readonly lastFundingAccrual: bigint | null;
  readonly badDebt: bigint;
  readonly longOi: bigint;
  readonly shortOi: bigint;
  /** Sum of the market's ROOQ_COMMIT ledger domain, from MarginVault Moved events. */
  readonly commitTotal: bigint;
  /** MarketBackstop-owned balance of the market's ROOQ_BACKSTOP domain. */
  readonly insurance: bigint;
  /** Creator-owned balance of the market's ROOQ_BACKSTOP domain. */
  readonly creatorBond: bigint;
  readonly takerFees: bigint;
  readonly tradeCount: number;
  readonly createdBlock: bigint;
  readonly createdTx: Hex;
  readonly createdAt: bigint;
  readonly statusBlock: bigint | null;
  readonly updatedBlock: bigint;
}

export interface PositionState {
  readonly marketId: Hex;
  readonly taker: Address;
  /** Zero address once the pair is closed, matching ClearingHouse.getPair after `delete`. */
  readonly maker: Address;
  readonly size: bigint;
  readonly entryPrice: bigint;
  readonly takerMargin: bigint;
  readonly makerMargin: bigint;
  readonly realizedPnl: bigint;
  readonly fundingPaid: bigint;
  readonly openedBlock: bigint | null;
  readonly updatedBlock: bigint;
  readonly updatedLogIndex: number;
  readonly updatedTx: Hex;
}

export interface PoolState {
  readonly pool: Address;
  readonly marketId: Hex | null;
  readonly token0: Address | null;
  readonly token1: Address | null;
  readonly feeBps: number | null;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly lpSupply: bigint;
  readonly feesAccrued0: bigint;
  readonly feesAccrued1: bigint;
  readonly paused: boolean;
  readonly swapCount: number;
  readonly createdBlock: bigint | null;
  readonly updatedBlock: bigint;
}

export interface LpBalanceState {
  readonly pool: Address;
  readonly holder: Address;
  readonly shares: bigint;
  readonly updatedBlock: bigint;
}

export interface VaultBalanceState {
  readonly domain: Hex;
  readonly account: Address;
  readonly balance: bigint;
  readonly updatedBlock: bigint;
}

export interface VaultState {
  readonly vault: Address;
  readonly totalLedger: bigint;
  readonly totalDeposits: bigint;
  readonly totalWithdrawals: bigint;
  readonly depositCount: number;
  readonly withdrawCount: number;
  readonly updatedBlock: bigint;
}

export interface FeedState {
  readonly feedId: Hex;
  readonly aggregator: Address;
  readonly asset: Address;
  readonly heartbeat: bigint;
  readonly decimals: number;
  readonly approved: boolean;
  readonly registeredBlock: bigint;
  readonly updatedBlock: bigint;
}

export type DomainLabel =
  | { readonly kind: "free" }
  | { readonly kind: "fees" }
  | { readonly kind: "commit"; readonly marketId: Hex }
  | { readonly kind: "backstop"; readonly marketId: Hex }
  | { readonly kind: "pair"; readonly marketId: Hex; readonly taker: Address };

export interface DerivedState {
  readonly markets: Map<Hex, MarketState>;
  readonly positions: Map<string, PositionState>;
  readonly pools: Map<Address, PoolState>;
  readonly lpBalances: Map<string, LpBalanceState>;
  readonly vaultBalances: Map<string, VaultBalanceState>;
  readonly vaults: Map<Address, VaultState>;
  readonly feeds: Map<Hex, FeedState>;
  readonly domains: Map<Hex, DomainLabel>;
  readonly poolMarkets: Map<Address, Hex>;
  readonly feedMarkets: Map<Address, Hex>;
}

export interface TradeRecord {
  readonly at: LogPosition;
  readonly kind: "perp" | "swap";
  readonly marketId: Hex | null;
  readonly pool: Address | null;
  readonly account: Address;
  readonly counterparty: Address | null;
  /** Signed 18-decimal base size: taker size for perps, bought(+)/sold(-) base for swaps. */
  readonly size: bigint | null;
  /** 18-decimal quote per base. */
  readonly price: bigint | null;
  readonly markPrice: bigint | null;
  readonly fee: bigint;
  readonly feeToken: Address | null;
  /** Quote notional in quote-token units. */
  readonly notionalQuote: bigint | null;
  readonly realizedPnl: bigint | null;
  readonly quoteHash: Hex | null;
  readonly tokenIn: Address | null;
  readonly tokenOut: Address | null;
  readonly amountIn: bigint | null;
  readonly amountOut: bigint | null;
}

export interface PositionEventRecord {
  readonly at: LogPosition;
  readonly marketId: Hex;
  readonly taker: Address;
  readonly maker: Address;
  readonly size: bigint;
  readonly entryPrice: bigint;
  readonly takerMargin: bigint;
  readonly makerMargin: bigint;
}

export interface FundingEventRecord {
  readonly at: LogPosition;
  readonly kind: "accrued" | "settled";
  readonly marketId: Hex;
  readonly taker: Address | null;
  readonly maker: Address | null;
  readonly fundingIndex: bigint | null;
  readonly indexDelta: bigint | null;
  readonly ratePerSecond: bigint | null;
  readonly price: bigint | null;
  readonly accruedAt: bigint | null;
  /** What the funding index charged the taker; `takerPaid` is what actually moved. */
  readonly takerOwed: bigint | null;
  readonly takerPaid: bigint | null;
}

export interface LiquidationRecord {
  readonly at: LogPosition;
  readonly kind: "liquidation" | "settled_at_mark";
  readonly marketId: Hex;
  readonly taker: Address;
  readonly liquidator: Address | null;
  readonly makerSide: boolean | null;
  readonly markPrice: bigint;
  readonly takerPnl: bigint;
  readonly penalty: bigint | null;
  readonly shortfallCovered: bigint | null;
  readonly badDebt: bigint | null;
}

export interface PoolEventRecord {
  readonly at: LogPosition;
  readonly pool: Address;
  readonly marketId: Hex | null;
  readonly eventKind: "add" | "remove" | "swap" | "reserves" | "pause" | "unpause" | "skim";
  readonly actor: Address | null;
  readonly counterparty: Address | null;
  /** Pool-perspective signed token deltas (positive flows into the pool). */
  readonly amount0: bigint | null;
  readonly amount1: bigint | null;
  readonly shares: bigint | null;
  readonly reserve0: bigint | null;
  readonly reserve1: bigint | null;
}

export interface VaultMovementRecord {
  readonly at: LogPosition;
  readonly vault: Address;
  readonly kind: "deposit" | "withdraw";
  readonly account: Address;
  readonly counterparty: Address;
  readonly amount: bigint;
}

export interface OracleObservationRecord {
  readonly at: LogPosition;
  readonly feed: Address;
  readonly marketId: Hex | null;
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly decimals: number;
  readonly priceWad: bigint | null;
  readonly updatedAt: bigint;
}

export interface MarketStatusRecord {
  readonly at: LogPosition;
  readonly marketId: Hex;
  readonly from: PerpStatus;
  readonly to: PerpStatus;
  readonly by: Address;
}

export interface DerivedHistory {
  readonly trades: TradeRecord[];
  readonly positionEvents: PositionEventRecord[];
  readonly fundingEvents: FundingEventRecord[];
  readonly liquidations: LiquidationRecord[];
  readonly poolEvents: PoolEventRecord[];
  readonly vaultMovements: VaultMovementRecord[];
  readonly oracleObservations: OracleObservationRecord[];
  readonly marketStatusEvents: MarketStatusRecord[];
}

export interface Touched {
  readonly markets: Set<Hex>;
  readonly positions: Set<string>;
  readonly pools: Set<Address>;
  readonly lpBalances: Set<string>;
  readonly vaultBalances: Set<string>;
  readonly vaults: Set<Address>;
  readonly feeds: Set<Hex>;
}

export interface InvariantViolation {
  readonly at: LogPosition;
  readonly entity: string;
  readonly message: string;
}

export interface ReduceOutput {
  readonly history: DerivedHistory;
  readonly touched: Touched;
  readonly violations: InvariantViolation[];
}

/** Static inputs a reducer may read. Everything here is fixed config or immutable onchain metadata. */
export interface ReducerContext {
  readonly chainId: number;
  readonly vault: Address;
  readonly backstop: Address;
  readonly collateral: Address;
  readonly collateralDecimals: number;
  /** Feed aggregator -> market, from the deployment record. */
  readonly configFeedMarkets: ReadonlyMap<Address, Hex>;
  readonly tokenDecimals: ReadonlyMap<Address, number>;
  readonly feedDecimals: ReadonlyMap<Address, number>;
}

export function emptyState(): DerivedState {
  return {
    markets: new Map(),
    positions: new Map(),
    pools: new Map(),
    lpBalances: new Map(),
    vaultBalances: new Map(),
    vaults: new Map(),
    feeds: new Map(),
    domains: new Map(),
    poolMarkets: new Map(),
    feedMarkets: new Map(),
  };
}

/** Records are immutable, so copying the maps yields an independent snapshot. */
export function cloneState(s: DerivedState): DerivedState {
  return {
    markets: new Map(s.markets),
    positions: new Map(s.positions),
    pools: new Map(s.pools),
    lpBalances: new Map(s.lpBalances),
    vaultBalances: new Map(s.vaultBalances),
    vaults: new Map(s.vaults),
    feeds: new Map(s.feeds),
    domains: new Map(s.domains),
    poolMarkets: new Map(s.poolMarkets),
    feedMarkets: new Map(s.feedMarkets),
  };
}

export function emptyOutput(): ReduceOutput {
  return {
    history: {
      trades: [],
      positionEvents: [],
      fundingEvents: [],
      liquidations: [],
      poolEvents: [],
      vaultMovements: [],
      oracleObservations: [],
      marketStatusEvents: [],
    },
    touched: {
      markets: new Set(),
      positions: new Set(),
      pools: new Set(),
      lpBalances: new Set(),
      vaultBalances: new Set(),
      vaults: new Set(),
      feeds: new Set(),
    },
    violations: [],
  };
}

export function positionKey(marketId: Hex, taker: Address): string {
  return `${marketId}:${taker}`;
}

export function lpKey(pool: Address, holder: Address): string {
  return `${pool}:${holder}`;
}

export function ledgerKey(domain: Hex, account: Address): string {
  return `${domain}:${account}`;
}
