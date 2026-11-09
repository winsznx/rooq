import type { Address, Hex } from "viem";
import type { IndexerHealth } from "@rooq/sdk";
import { optionalHistory, type Db } from "./db";
import { logError } from "./log";

export interface StatusRow {
  readonly status: "ok" | "behind" | "degraded";
  readonly reason: string | null;
  readonly last_indexed_block: bigint | null;
  readonly head_block: bigint | null;
  readonly last_reconciled_block: bigint | null;
  readonly updated_at: Date;
}

export interface HealthLimits {
  readonly staleSeconds: number;
  readonly maxLagBlocks: number;
}

const DOWN = (reason: string): IndexerHealth => ({
  status: "down",
  lastIndexedBlock: null,
  headBlock: null,
  lagBlocks: null,
  lastReconciledBlock: null,
  reason,
});

/**
 * Pure: indexer health from its status row, the RPC head and the wall clock. A heartbeat older than
 * the limit means the indexer process is down even if the database still answers.
 */
export function computeIndexerHealth(row: StatusRow | null, head: bigint | null, nowMs: number, limits: HealthLimits): IndexerHealth {
  if (!row) return DOWN("the indexer has not run for this chain");
  const ageSeconds = Math.floor((nowMs - row.updated_at.getTime()) / 1000);
  const last = row.last_indexed_block;
  const base = {
    lastIndexedBlock: last === null ? null : last.toString(),
    headBlock: head === null ? null : head.toString(),
    lagBlocks: head === null || last === null ? null : Math.max(0, Number(head - last)),
    lastReconciledBlock: row.last_reconciled_block === null ? null : row.last_reconciled_block.toString(),
  };
  if (ageSeconds > limits.staleSeconds) return { ...base, status: "down", reason: `no indexer heartbeat for ${ageSeconds}s` };
  if (row.status === "degraded") return { ...base, status: "degraded", reason: row.reason ?? "degraded" };
  if (base.lagBlocks !== null && base.lagBlocks > limits.maxLagBlocks) return { ...base, status: "behind", reason: `${base.lagBlocks} blocks behind head` };
  if (row.status === "behind") return { ...base, status: "behind", reason: row.reason };
  return { ...base, status: "ok", reason: null };
}

export async function indexerHealth(sql: Db, chainId: number, head: bigint | null, limits: HealthLimits): Promise<IndexerHealth> {
  try {
    const rows = await optionalHistory(
      sql,
      (q) => q<StatusRow[]>`
        SELECT status, reason, last_indexed_block, head_block, last_reconciled_block, updated_at
        FROM indexer_status WHERE chain_id = ${chainId}`,
    );
    if (rows === null) return DOWN("indexer database unreachable");
    return computeIndexerHealth(rows[0] ?? null, head, Date.now(), limits);
  } catch (error) {
    logError("indexer_status_query_failed", error);
    return DOWN("indexer status unreadable");
  }
}

export interface WindowStats {
  readonly refPrice: bigint | null;
  readonly firstPrice: bigint | null;
  readonly lastPrice: bigint | null;
  readonly volumeQuote: bigint | null;
  readonly trades: number;
}

interface WindowRow {
  readonly market_id: Hex;
  readonly kind: "perp" | "swap";
  readonly first_price: string | null;
  readonly last_price: string | null;
  readonly volume: string | null;
  readonly n: bigint;
}

interface RefRow {
  readonly market_id: Hex;
  readonly kind: "perp" | "swap";
  readonly price: string;
}

const big = (x: string | null): bigint | null => (x === null ? null : BigInt(x));

/** Trailing-window stats per market and trade kind from indexed executed trades, by chain time. */
export async function windowStats(
  sql: Db,
  chainId: number,
  marketIds: readonly Hex[],
  since: bigint,
  until: bigint,
): Promise<Map<string, WindowStats>> {
  if (marketIds.length === 0) return new Map();
  const ids = marketIds.map((m) => m.toLowerCase());
  const [rows, refs] = await Promise.all([
    sql<WindowRow[]>`
      SELECT market_id, kind,
        (array_agg(price ORDER BY block_number, log_index))[1]::text AS first_price,
        (array_agg(price ORDER BY block_number DESC, log_index DESC))[1]::text AS last_price,
        sum(notional_quote)::text AS volume,
        count(*) AS n
      FROM trades
      WHERE chain_id = ${chainId} AND market_id IN ${sql(ids)} AND price IS NOT NULL
        AND block_timestamp > ${since.toString()} AND block_timestamp <= ${until.toString()}
      GROUP BY market_id, kind`,
    sql<RefRow[]>`
      SELECT DISTINCT ON (market_id, kind) market_id, kind, price::text AS price
      FROM trades
      WHERE chain_id = ${chainId} AND market_id IN ${sql(ids)} AND price IS NOT NULL AND block_timestamp <= ${since.toString()}
      ORDER BY market_id, kind, block_number DESC, log_index DESC`,
  ]);
  const refByKey = new Map(refs.map((r) => [`${r.market_id}:${r.kind}`, BigInt(r.price)]));
  return new Map(
    rows.map((r) => [
      `${r.market_id}:${r.kind}`,
      {
        refPrice: refByKey.get(`${r.market_id}:${r.kind}`) ?? null,
        firstPrice: big(r.first_price),
        lastPrice: big(r.last_price),
        volumeQuote: big(r.volume),
        trades: Number(r.n),
      },
    ]),
  );
}

export interface TradeDbRow {
  readonly kind: "perp" | "swap";
  readonly tx_hash: Hex;
  readonly log_index: number;
  readonly block_number: bigint;
  readonly block_timestamp: bigint;
  readonly account: Address;
  readonly size: string;
  readonly price: string;
  readonly fee: string;
  readonly fee_token: Address | null;
}

export async function tradesPage(
  sql: Db,
  chainId: number,
  marketId: Hex,
  before: { block: bigint; log: bigint } | null,
  limit: number,
): Promise<TradeDbRow[]> {
  const id = marketId.toLowerCase();
  return before
    ? sql<TradeDbRow[]>`
        SELECT kind, tx_hash, log_index, block_number, block_timestamp, account, size::text AS size, price::text AS price, fee::text AS fee, fee_token
        FROM trades
        WHERE chain_id = ${chainId} AND market_id = ${id} AND price IS NOT NULL AND size IS NOT NULL
          AND (block_number, log_index) < (${before.block.toString()}, ${before.log.toString()})
        ORDER BY block_number DESC, log_index DESC LIMIT ${limit}`
    : sql<TradeDbRow[]>`
        SELECT kind, tx_hash, log_index, block_number, block_timestamp, account, size::text AS size, price::text AS price, fee::text AS fee, fee_token
        FROM trades
        WHERE chain_id = ${chainId} AND market_id = ${id} AND price IS NOT NULL AND size IS NOT NULL
        ORDER BY block_number DESC, log_index DESC LIMIT ${limit}`;
}

export interface CandleDbRow {
  readonly t: bigint;
  readonly o: string;
  readonly h: string;
  readonly l: string;
  readonly c: string;
  readonly v: string;
}

/** Newest-first buckets that contain at least one execution; empty buckets are never produced. */
export async function tradeCandles(sql: Db, chainId: number, marketId: Hex, kind: "perp" | "swap", seconds: number, limit: number): Promise<CandleDbRow[]> {
  return sql<CandleDbRow[]>`
    SELECT (block_timestamp / ${seconds}) * ${seconds} AS t,
      (array_agg(price ORDER BY block_number, log_index))[1]::text AS o,
      max(price)::text AS h,
      min(price)::text AS l,
      (array_agg(price ORDER BY block_number DESC, log_index DESC))[1]::text AS c,
      sum(abs(size))::text AS v
    FROM trades
    WHERE chain_id = ${chainId} AND market_id = ${marketId.toLowerCase()} AND kind = ${kind} AND price IS NOT NULL AND size IS NOT NULL
    GROUP BY 1 ORDER BY 1 DESC LIMIT ${limit}`;
}

/** Oracle series: OHLC of normalised answers; `v` is the number of feed updates in the bucket. */
export async function oracleCandles(sql: Db, chainId: number, marketId: Hex, seconds: number, limit: number): Promise<CandleDbRow[]> {
  return sql<CandleDbRow[]>`
    SELECT (block_timestamp / ${seconds}) * ${seconds} AS t,
      (array_agg(price_wad ORDER BY block_number, log_index))[1]::text AS o,
      max(price_wad)::text AS h,
      min(price_wad)::text AS l,
      (array_agg(price_wad ORDER BY block_number DESC, log_index DESC))[1]::text AS c,
      count(*)::text AS v
    FROM oracle_observations
    WHERE chain_id = ${chainId} AND market_id = ${marketId.toLowerCase()} AND price_wad IS NOT NULL
    GROUP BY 1 ORDER BY 1 DESC LIMIT ${limit}`;
}

export interface ActivityDbRow {
  readonly id: bigint;
  readonly block_number: bigint;
  readonly block_timestamp: bigint;
  readonly tx_hash: Hex;
  readonly log_index: number;
  readonly event_name: string;
  readonly args: unknown;
  readonly market_id: Hex | null;
  readonly canonical: boolean;
  readonly market_base: Address | null;
  readonly pool_token0: Address | null;
  readonly pool_token1: Address | null;
}

/**
 * Activity from raw events. Orphaned rows are kept (as "rechecking") unless the same transaction is
 * canonical again elsewhere, so a reorged receipt is shown as changed rather than silently hidden.
 */
export async function activityPage(
  sql: Db,
  chainId: number,
  wallet: Address,
  before: { block: bigint; log: bigint; id: bigint } | null,
  limit: number,
): Promise<ActivityDbRow[]> {
  const who = [wallet.toLowerCase()];
  const page = before
    ? sql`AND (r.block_number, r.log_index, r.id) < (${before.block.toString()}, ${before.log.toString()}, ${before.id.toString()})`
    : sql``;
  return sql<ActivityDbRow[]>`
    SELECT r.id, r.block_number, r.block_timestamp, r.tx_hash, r.log_index, r.event_name, r.args, r.market_id, r.canonical,
      m.base AS market_base, p.token0 AS pool_token0, p.token1 AS pool_token1
    FROM raw_events r
    LEFT JOIN markets m ON m.chain_id = r.chain_id AND m.market_id = r.market_id
    LEFT JOIN pools p ON p.chain_id = r.chain_id AND p.pool = r.address
    WHERE r.chain_id = ${chainId} AND r.actors @> ${sql.array(who)}::text[] AND r.event_name IS NOT NULL
      AND (r.canonical OR NOT EXISTS (
        SELECT 1 FROM raw_events c WHERE c.chain_id = r.chain_id AND c.tx_hash = r.tx_hash AND c.canonical))
      ${page}
    ORDER BY r.block_number DESC, r.log_index DESC, r.id DESC
    LIMIT ${limit}`;
}

export interface MetaRow {
  readonly address: Address;
  readonly symbol: string | null;
  readonly decimals: number;
}

export async function tokenMeta(sql: Db, chainId: number): Promise<Map<string, MetaRow>> {
  const rows = await sql<MetaRow[]>`SELECT address, symbol, decimals FROM contract_meta WHERE chain_id = ${chainId} AND kind = 'token'`;
  return new Map(rows.map((r) => [r.address.toLowerCase(), r]));
}

export async function takerMarkets(sql: Db, chainId: number, wallet: Address): Promise<Hex[]> {
  const rows = await sql<{ market_id: Hex }[]>`
    SELECT DISTINCT market_id FROM positions WHERE chain_id = ${chainId} AND taker = ${wallet.toLowerCase()}`;
  return rows.map((r) => r.market_id);
}

export async function txSightings(sql: Db, chainId: number, hash: Hex): Promise<{ canonical: boolean; block_number: bigint }[]> {
  return sql<{ canonical: boolean; block_number: bigint }[]>`
    SELECT canonical, max(block_number) AS block_number FROM raw_events
    WHERE chain_id = ${chainId} AND tx_hash = ${hash.toLowerCase()} GROUP BY canonical`;
}

export interface StatusChangeRow {
  readonly market_id: Hex;
  readonly from_status: string;
  readonly to_status: string;
  readonly block_number: bigint;
  readonly tx_hash: Hex;
}

export async function lastStatusChanges(sql: Db, chainId: number): Promise<Map<string, StatusChangeRow>> {
  const rows = await sql<StatusChangeRow[]>`
    SELECT DISTINCT ON (market_id) market_id, from_status, to_status, block_number, tx_hash
    FROM market_status_events WHERE chain_id = ${chainId}
    ORDER BY market_id, block_number DESC, log_index DESC`;
  return new Map(rows.map((r) => [r.market_id, r]));
}

export async function lastReconciliation(sql: Db, chainId: number) {
  const rows = await sql<{ block_number: bigint; ok: boolean; checks: number; mismatches: number; error: string | null; created_at: Date }[]>`
    SELECT block_number, ok, checks, mismatches, error, created_at FROM reconciliations WHERE chain_id = ${chainId} ORDER BY id DESC LIMIT 1`;
  return rows[0] ?? null;
}

export async function lastReorg(sql: Db, chainId: number) {
  const rows = await sql<{ common_ancestor: bigint; depth: number; orphaned_events: number; detected_at: Date }[]>`
    SELECT common_ancestor, depth, orphaned_events, detected_at FROM reorgs WHERE chain_id = ${chainId} ORDER BY id DESC LIMIT 1`;
  return rows[0] ?? null;
}

export interface StreamRow {
  readonly seq: bigint;
  readonly type: string;
  readonly market_id: Hex | null;
  readonly block_number: bigint;
  readonly block_hash: Hex;
  readonly tx_hash: Hex | null;
  readonly log_index: number | null;
  readonly event_id: string;
  readonly reverted: boolean;
  readonly payload: unknown;
  readonly observed_at: Date;
}

export async function streamAfter(sql: Db, chainId: number, after: bigint, marketId: Hex | null, limit: number): Promise<StreamRow[]> {
  const market = marketId ? sql`AND market_id = ${marketId.toLowerCase()}` : sql``;
  return sql<StreamRow[]>`
    SELECT seq, type, market_id, block_number, block_hash, tx_hash, log_index, event_id, reverted, payload, observed_at
    FROM stream_events WHERE chain_id = ${chainId} AND seq > ${after.toString()} ${market}
    ORDER BY seq LIMIT ${limit}`;
}

export async function maxStreamSeq(sql: Db, chainId: number): Promise<bigint> {
  const rows = await sql<{ seq: bigint | null }[]>`SELECT max(seq) AS seq FROM stream_events WHERE chain_id = ${chainId}`;
  return rows[0]?.seq ?? 0n;
}

export async function syncState(sql: Db, chainId: number): Promise<{ last_indexed_block: bigint | null; last_indexed_hash: Hex | null; status: string } | null> {
  const rows = await sql<{ last_indexed_block: bigint | null; last_indexed_hash: Hex | null; status: string }[]>`
    SELECT last_indexed_block, last_indexed_hash, status FROM indexer_status WHERE chain_id = ${chainId}`;
  return rows[0] ?? null;
}
