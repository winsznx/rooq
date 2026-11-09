import type { JsonValue, LogPosition } from "./decode";
import { domainKind } from "./reducers";
import type {
  DerivedHistory,
  DerivedState,
  FeedState,
  LpBalanceState,
  MarketState,
  PoolState,
  PositionState,
  VaultBalanceState,
  VaultState,
} from "./state";

/**
 * Values handed to postgres.js. Big integers travel as decimal strings into NUMERIC columns; jsonb and
 * text[] columns take plain JSON values and arrays, which postgres.js serialises from the column type.
 */
export type DbValue = JsonValue;
export type DbRow = Record<string, DbValue>;

export interface TableSpec {
  readonly name: string;
  readonly columns: readonly string[];
  readonly key: readonly string[];
}

const num = (x: bigint | null): string | null => (x === null ? null : x.toString());

function eventColumns(chainId: number, at: LogPosition): DbRow {
  return {
    chain_id: chainId,
    tx_hash: at.txHash,
    log_index: at.logIndex,
    block_number: at.blockNumber.toString(),
    block_timestamp: at.blockTimestamp.toString(),
  };
}

const EVENT_COLUMNS = ["chain_id", "tx_hash", "log_index", "block_number", "block_timestamp"] as const;
const EVENT_KEY = ["chain_id", "tx_hash", "log_index"] as const;

export const TABLES = {
  markets: {
    name: "markets",
    key: ["chain_id", "market_id"],
    columns: [
      "chain_id", "market_id", "base", "quote", "creator", "pool", "spot_status", "perp_status", "tier_id", "feed_id",
      "max_oi_usd_wad", "imr_wad", "risk_version", "funding_index", "funding_rate_per_second", "last_funding_accrual",
      "bad_debt", "long_oi", "short_oi", "commit_total", "insurance", "creator_bond", "taker_fees", "trade_count",
      "created_block", "created_tx", "created_at", "status_block", "updated_block",
    ],
  },
  positions: {
    name: "positions",
    key: ["chain_id", "market_id", "taker"],
    columns: [
      "chain_id", "market_id", "taker", "maker", "size", "entry_price", "taker_margin", "maker_margin", "realized_pnl",
      "funding_paid", "opened_block", "updated_block", "updated_log_index", "updated_tx",
    ],
  },
  pools: {
    name: "pools",
    key: ["chain_id", "pool"],
    columns: [
      "chain_id", "pool", "market_id", "token0", "token1", "fee_bps", "reserve0", "reserve1", "lp_supply",
      "fees_accrued0", "fees_accrued1", "paused", "swap_count", "created_block", "updated_block",
    ],
  },
  lpBalances: { name: "lp_balances", key: ["chain_id", "pool", "holder"], columns: ["chain_id", "pool", "holder", "shares", "updated_block"] },
  vaultBalances: {
    name: "vault_balances",
    key: ["chain_id", "domain", "account"],
    columns: ["chain_id", "domain", "account", "balance", "domain_kind", "market_id", "updated_block"],
  },
  vaults: {
    name: "vault_state",
    key: ["chain_id", "vault"],
    columns: ["chain_id", "vault", "total_ledger", "total_deposits", "total_withdrawals", "deposit_count", "withdraw_count", "updated_block"],
  },
  feeds: {
    name: "feeds",
    key: ["chain_id", "feed_id"],
    columns: ["chain_id", "feed_id", "aggregator", "asset", "heartbeat", "decimals", "approved", "registered_block", "updated_block"],
  },
  trades: {
    name: "trades",
    key: EVENT_KEY,
    columns: [
      ...EVENT_COLUMNS, "kind", "market_id", "pool", "account", "counterparty", "size", "price", "mark_price", "fee", "fee_token",
      "notional_quote", "realized_pnl", "quote_hash", "token_in", "token_out", "amount_in", "amount_out",
    ],
  },
  positionEvents: {
    name: "position_events",
    key: EVENT_KEY,
    columns: [...EVENT_COLUMNS, "market_id", "taker", "maker", "size", "entry_price", "taker_margin", "maker_margin"],
  },
  fundingEvents: {
    name: "funding_events",
    key: EVENT_KEY,
    columns: [
      ...EVENT_COLUMNS, "kind", "market_id", "taker", "maker", "funding_index", "index_delta", "rate_per_second", "price",
      "accrued_at", "taker_owed", "taker_paid",
    ],
  },
  liquidations: {
    name: "liquidations",
    key: EVENT_KEY,
    columns: [
      ...EVENT_COLUMNS, "kind", "market_id", "taker", "liquidator", "maker_side", "mark_price", "taker_pnl", "penalty",
      "shortfall_covered", "bad_debt",
    ],
  },
  poolEvents: {
    name: "pool_events",
    key: EVENT_KEY,
    columns: [...EVENT_COLUMNS, "pool", "market_id", "event_kind", "actor", "counterparty", "amount0", "amount1", "shares", "reserve0", "reserve1"],
  },
  vaultMovements: {
    name: "vault_movements",
    key: EVENT_KEY,
    columns: [...EVENT_COLUMNS, "vault", "kind", "account", "counterparty", "amount"],
  },
  oracleObservations: {
    name: "oracle_observations",
    key: EVENT_KEY,
    columns: [...EVENT_COLUMNS, "feed", "market_id", "round_id", "answer", "decimals", "price_wad", "updated_at"],
  },
  marketStatusEvents: {
    name: "market_status_events",
    key: EVENT_KEY,
    columns: [...EVENT_COLUMNS, "market_id", "from_status", "to_status", "changed_by"],
  },
} as const satisfies Record<string, TableSpec>;

export type TableName = keyof typeof TABLES;
export const STATE_TABLES = ["markets", "positions", "pools", "lpBalances", "vaultBalances", "vaults", "feeds"] as const;
export const HISTORY_TABLES = [
  "trades",
  "positionEvents",
  "fundingEvents",
  "liquidations",
  "poolEvents",
  "vaultMovements",
  "oracleObservations",
  "marketStatusEvents",
] as const;
/** Everything replay deletes and rebuilds. */
export const DERIVED_TABLES: readonly TableName[] = [...STATE_TABLES, ...HISTORY_TABLES];

export function marketRow(chainId: number, m: MarketState): DbRow {
  return {
    chain_id: chainId,
    market_id: m.marketId,
    base: m.base,
    quote: m.quote,
    creator: m.creator,
    pool: m.pool,
    spot_status: m.spotStatus,
    perp_status: m.perpStatus,
    tier_id: m.tierId,
    feed_id: m.feedId,
    max_oi_usd_wad: num(m.maxOiUsdWad),
    imr_wad: num(m.imrWad),
    risk_version: m.riskVersion,
    funding_index: m.fundingIndex.toString(),
    funding_rate_per_second: num(m.fundingRatePerSecond),
    last_funding_accrual: num(m.lastFundingAccrual),
    bad_debt: m.badDebt.toString(),
    long_oi: m.longOi.toString(),
    short_oi: m.shortOi.toString(),
    commit_total: m.commitTotal.toString(),
    insurance: m.insurance.toString(),
    creator_bond: m.creatorBond.toString(),
    taker_fees: m.takerFees.toString(),
    trade_count: m.tradeCount,
    created_block: m.createdBlock.toString(),
    created_tx: m.createdTx,
    created_at: m.createdAt.toString(),
    status_block: num(m.statusBlock),
    updated_block: m.updatedBlock.toString(),
  };
}

export function positionRow(chainId: number, p: PositionState): DbRow {
  return {
    chain_id: chainId,
    market_id: p.marketId,
    taker: p.taker,
    maker: p.maker,
    size: p.size.toString(),
    entry_price: p.entryPrice.toString(),
    taker_margin: p.takerMargin.toString(),
    maker_margin: p.makerMargin.toString(),
    realized_pnl: p.realizedPnl.toString(),
    funding_paid: p.fundingPaid.toString(),
    opened_block: num(p.openedBlock),
    updated_block: p.updatedBlock.toString(),
    updated_log_index: p.updatedLogIndex,
    updated_tx: p.updatedTx,
  };
}

export function poolRow(chainId: number, p: PoolState): DbRow {
  return {
    chain_id: chainId,
    pool: p.pool,
    market_id: p.marketId,
    token0: p.token0,
    token1: p.token1,
    fee_bps: p.feeBps,
    reserve0: p.reserve0.toString(),
    reserve1: p.reserve1.toString(),
    lp_supply: p.lpSupply.toString(),
    fees_accrued0: p.feesAccrued0.toString(),
    fees_accrued1: p.feesAccrued1.toString(),
    paused: p.paused,
    swap_count: p.swapCount,
    created_block: num(p.createdBlock),
    updated_block: p.updatedBlock.toString(),
  };
}

export function lpRow(chainId: number, b: LpBalanceState): DbRow {
  return { chain_id: chainId, pool: b.pool, holder: b.holder, shares: b.shares.toString(), updated_block: b.updatedBlock.toString() };
}

export function vaultBalanceRow(chainId: number, state: DerivedState, b: VaultBalanceState): DbRow {
  const label = domainKind(state, b.domain);
  return {
    chain_id: chainId,
    domain: b.domain,
    account: b.account,
    balance: b.balance.toString(),
    domain_kind: label.kind,
    market_id: label.marketId,
    updated_block: b.updatedBlock.toString(),
  };
}

export function vaultRow(chainId: number, v: VaultState): DbRow {
  return {
    chain_id: chainId,
    vault: v.vault,
    total_ledger: v.totalLedger.toString(),
    total_deposits: v.totalDeposits.toString(),
    total_withdrawals: v.totalWithdrawals.toString(),
    deposit_count: v.depositCount,
    withdraw_count: v.withdrawCount,
    updated_block: v.updatedBlock.toString(),
  };
}

export function feedRow(chainId: number, f: FeedState): DbRow {
  return {
    chain_id: chainId,
    feed_id: f.feedId,
    aggregator: f.aggregator,
    asset: f.asset,
    heartbeat: f.heartbeat.toString(),
    decimals: f.decimals,
    approved: f.approved,
    registered_block: f.registeredBlock.toString(),
    updated_block: f.updatedBlock.toString(),
  };
}

export function historyRows(chainId: number, h: DerivedHistory): Record<(typeof HISTORY_TABLES)[number], DbRow[]> {
  return {
    trades: h.trades.map((t) => ({
      ...eventColumns(chainId, t.at),
      kind: t.kind,
      market_id: t.marketId,
      pool: t.pool,
      account: t.account,
      counterparty: t.counterparty,
      size: num(t.size),
      price: num(t.price),
      mark_price: num(t.markPrice),
      fee: t.fee.toString(),
      fee_token: t.feeToken,
      notional_quote: num(t.notionalQuote),
      realized_pnl: num(t.realizedPnl),
      quote_hash: t.quoteHash,
      token_in: t.tokenIn,
      token_out: t.tokenOut,
      amount_in: num(t.amountIn),
      amount_out: num(t.amountOut),
    })),
    positionEvents: h.positionEvents.map((p) => ({
      ...eventColumns(chainId, p.at),
      market_id: p.marketId,
      taker: p.taker,
      maker: p.maker,
      size: p.size.toString(),
      entry_price: p.entryPrice.toString(),
      taker_margin: p.takerMargin.toString(),
      maker_margin: p.makerMargin.toString(),
    })),
    fundingEvents: h.fundingEvents.map((f) => ({
      ...eventColumns(chainId, f.at),
      kind: f.kind,
      market_id: f.marketId,
      taker: f.taker,
      maker: f.maker,
      funding_index: num(f.fundingIndex),
      index_delta: num(f.indexDelta),
      rate_per_second: num(f.ratePerSecond),
      price: num(f.price),
      accrued_at: num(f.accruedAt),
      taker_owed: num(f.takerOwed),
      taker_paid: num(f.takerPaid),
    })),
    liquidations: h.liquidations.map((l) => ({
      ...eventColumns(chainId, l.at),
      kind: l.kind,
      market_id: l.marketId,
      taker: l.taker,
      liquidator: l.liquidator,
      maker_side: l.makerSide,
      mark_price: l.markPrice.toString(),
      taker_pnl: l.takerPnl.toString(),
      penalty: num(l.penalty),
      shortfall_covered: num(l.shortfallCovered),
      bad_debt: num(l.badDebt),
    })),
    poolEvents: h.poolEvents.map((p) => ({
      ...eventColumns(chainId, p.at),
      pool: p.pool,
      market_id: p.marketId,
      event_kind: p.eventKind,
      actor: p.actor,
      counterparty: p.counterparty,
      amount0: num(p.amount0),
      amount1: num(p.amount1),
      shares: num(p.shares),
      reserve0: num(p.reserve0),
      reserve1: num(p.reserve1),
    })),
    vaultMovements: h.vaultMovements.map((v) => ({
      ...eventColumns(chainId, v.at),
      vault: v.vault,
      kind: v.kind,
      account: v.account,
      counterparty: v.counterparty,
      amount: v.amount.toString(),
    })),
    oracleObservations: h.oracleObservations.map((o) => ({
      ...eventColumns(chainId, o.at),
      feed: o.feed,
      market_id: o.marketId,
      round_id: o.roundId.toString(),
      answer: o.answer.toString(),
      decimals: o.decimals,
      price_wad: num(o.priceWad),
      updated_at: o.updatedAt.toString(),
    })),
    marketStatusEvents: h.marketStatusEvents.map((s) => ({
      ...eventColumns(chainId, s.at),
      market_id: s.marketId,
      from_status: s.from,
      to_status: s.to,
      changed_by: s.by,
    })),
  };
}

/** State rows for the given keys, or for everything when `only` is omitted. */
export function stateRows(
  chainId: number,
  state: DerivedState,
  only?: {
    readonly markets: ReadonlySet<string>;
    readonly positions: ReadonlySet<string>;
    readonly pools: ReadonlySet<string>;
    readonly lpBalances: ReadonlySet<string>;
    readonly vaultBalances: ReadonlySet<string>;
    readonly vaults: ReadonlySet<string>;
    readonly feeds: ReadonlySet<string>;
  },
): Record<(typeof STATE_TABLES)[number], DbRow[]> {
  const pick = <V>(map: ReadonlyMap<string, V>, keys: ReadonlySet<string> | undefined): V[] =>
    keys === undefined
      ? [...map.values()]
      : [...keys].flatMap((k) => {
          const v = map.get(k);
          return v === undefined ? [] : [v];
        });
  return {
    markets: pick(state.markets, only?.markets).map((m) => marketRow(chainId, m)),
    positions: pick(state.positions, only?.positions).map((p) => positionRow(chainId, p)),
    pools: pick(state.pools, only?.pools).map((p) => poolRow(chainId, p)),
    lpBalances: pick(state.lpBalances, only?.lpBalances).map((b) => lpRow(chainId, b)),
    vaultBalances: pick(state.vaultBalances, only?.vaultBalances).map((b) => vaultBalanceRow(chainId, state, b)),
    vaults: pick(state.vaults, only?.vaults).map((v) => vaultRow(chainId, v)),
    feeds: pick(state.feeds, only?.feeds).map((f) => feedRow(chainId, f)),
  };
}
