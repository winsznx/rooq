import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { MAX_PARAMETERS, type Queryable } from "./db";
import { decodeLog, isContractKind, toJson, type ContractKind, type DecodedEvent, type IndexedEvent, type JsonValue, type LogPosition } from "./decode";
import type { EventFacts } from "./facts";
import { applyEvent } from "./reducers";
import { DERIVED_TABLES, HISTORY_TABLES, STATE_TABLES, TABLES, historyRows, stateRows, type DbRow, type TableSpec } from "./rows";
import { emptyOutput, emptyState, type DerivedHistory, type DerivedState, type InvariantViolation, type ReducerContext, type Touched } from "./state";

export const CURSOR_STREAM = "rooq";

type WriteMode = "insert" | "upsert" | "ignore";

/** Bulk insert in chunks that stay under Postgres' bind-parameter limit. */
export async function insertRows(q: Queryable, spec: TableSpec, rows: readonly DbRow[], mode: WriteMode): Promise<void> {
  if (rows.length === 0) return;
  const columns = [...spec.columns];
  const key = [...spec.key];
  const perChunk = Math.max(1, Math.floor(MAX_PARAMETERS / columns.length));
  const update = columns
    .filter((c) => !key.includes(c))
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .join(", ");
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    if (mode === "insert") {
      await q`INSERT INTO ${q(spec.name)} ${q(chunk, columns)}`;
    } else if (mode === "ignore") {
      await q`INSERT INTO ${q(spec.name)} ${q(chunk, columns)} ON CONFLICT (${q(key)}) DO NOTHING`;
    } else {
      await q`INSERT INTO ${q(spec.name)} ${q(chunk, columns)} ON CONFLICT (${q(key)}) DO UPDATE SET ${q.unsafe(update)}`;
    }
  }
}

export async function writeState(q: Queryable, chainId: number, state: DerivedState, touched?: Touched): Promise<void> {
  const rows = stateRows(chainId, state, touched);
  for (const table of STATE_TABLES) await insertRows(q, TABLES[table], rows[table], "upsert");
}

export async function writeHistory(q: Queryable, chainId: number, history: DerivedHistory): Promise<void> {
  const rows = historyRows(chainId, history);
  for (const table of HISTORY_TABLES) await insertRows(q, TABLES[table], rows[table], "insert");
}

// ------------------------------------------------------------------ source layer

export interface BlockHeader {
  readonly number: bigint;
  readonly hash: Hex;
  readonly parentHash: Hex;
  readonly timestamp: bigint;
}

export interface RawEventInput {
  readonly at: LogPosition;
  readonly contract: ContractKind;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly decoded: DecodedEvent | null;
  readonly facts: EventFacts | null;
}

const BLOCK_SPEC: TableSpec = {
  name: "chain_blocks",
  key: ["chain_id", "hash"],
  columns: ["chain_id", "number", "hash", "parent_hash", "timestamp", "canonical", "log_count"],
};

const RAW_SPEC: TableSpec = {
  name: "raw_events",
  key: ["chain_id", "block_hash", "log_index"],
  columns: [
    "chain_id", "block_number", "block_hash", "block_timestamp", "tx_hash", "tx_index", "log_index", "tx_from", "address",
    "contract", "topic0", "topic1", "topic2", "topic3", "data", "event_name", "args", "market_id", "actors", "canonical",
  ],
};

const STREAM_SPEC: TableSpec = {
  name: "stream_events",
  key: ["seq"],
  columns: ["chain_id", "type", "market_id", "block_number", "block_hash", "tx_hash", "log_index", "event_id", "reverted", "payload"],
};

export function eventId(chainId: number, blockHash: Hex, logIndex: number): string {
  return `${chainId}:${blockHash}:${logIndex}`;
}

function streamPayload(raw: RawEventInput): JsonValue {
  return {
    event: raw.decoded?.event.eventName ?? null,
    contract: raw.contract,
    address: raw.at.address,
    args: raw.decoded ? toJson(raw.decoded.event.args) : null,
  };
}

export interface BatchWrite {
  readonly chainId: number;
  readonly blocks: readonly BlockHeader[];
  readonly logCounts: ReadonlyMap<bigint, number>;
  readonly raw: readonly RawEventInput[];
  readonly state: DerivedState;
  readonly touched: Touched;
  readonly history: DerivedHistory;
  readonly cursor: { readonly block: bigint; readonly hash: Hex };
}

/**
 * Writes one indexed range. Called inside a transaction together with the cursor and status update,
 * so a crash leaves either the whole range or none of it.
 */
export async function writeBatch(q: Queryable, batch: BatchWrite): Promise<void> {
  const { chainId } = batch;
  // A header seen before on an abandoned fork can become canonical again (A -> B -> A); flip it back.
  const blockRows: DbRow[] = batch.blocks.map((b) => ({
    chain_id: chainId,
    number: b.number.toString(),
    hash: b.hash,
    parent_hash: b.parentHash,
    timestamp: b.timestamp.toString(),
    canonical: true,
    log_count: batch.logCounts.get(b.number) ?? 0,
  }));
  for (let i = 0; i < blockRows.length; i += 5_000) {
    const chunk = blockRows.slice(i, i + 5_000);
    await q`INSERT INTO chain_blocks ${q(chunk, [...BLOCK_SPEC.columns])}
      ON CONFLICT (chain_id, hash) DO UPDATE SET canonical = true`;
  }

  const rawRows: DbRow[] = batch.raw.map((r) => ({
    chain_id: chainId,
    block_number: r.at.blockNumber.toString(),
    block_hash: r.at.blockHash,
    block_timestamp: r.at.blockTimestamp.toString(),
    tx_hash: r.at.txHash,
    tx_index: r.at.txIndex,
    log_index: r.at.logIndex,
    tx_from: r.at.txFrom,
    address: r.at.address,
    contract: r.contract,
    topic0: r.topics[0] ?? null,
    topic1: r.topics[1] ?? null,
    topic2: r.topics[2] ?? null,
    topic3: r.topics[3] ?? null,
    data: r.data,
    event_name: r.decoded?.event.eventName ?? null,
    args: r.decoded ? toJson(r.decoded.event.args) : null,
    market_id: r.facts?.marketId ?? null,
    actors: [...(r.facts?.actors ?? [])],
    canonical: true,
  }));
  const perChunk = Math.floor(MAX_PARAMETERS / RAW_SPEC.columns.length);
  for (let i = 0; i < rawRows.length; i += perChunk) {
    const chunk = rawRows.slice(i, i + perChunk);
    await q`INSERT INTO raw_events ${q(chunk, [...RAW_SPEC.columns])}
      ON CONFLICT (chain_id, block_hash, log_index) DO UPDATE SET canonical = true`;
  }

  const streamRows: DbRow[] = batch.raw
    .filter((r) => r.facts?.streamType)
    .map((r) => ({
      chain_id: chainId,
      type: r.facts?.streamType ?? null,
      market_id: r.facts?.marketId ?? null,
      block_number: r.at.blockNumber.toString(),
      block_hash: r.at.blockHash,
      tx_hash: r.at.txHash,
      log_index: r.at.logIndex,
      event_id: eventId(chainId, r.at.blockHash, r.at.logIndex),
      reverted: false,
      payload: streamPayload(r),
    }));
  await insertRows(q, STREAM_SPEC, streamRows, "insert");

  await writeState(q, chainId, batch.state, batch.touched);
  await writeHistory(q, chainId, batch.history);
  await q`INSERT INTO indexer_cursors (chain_id, stream, last_block, last_hash, updated_at)
    VALUES (${chainId}, ${CURSOR_STREAM}, ${batch.cursor.block.toString()}, ${batch.cursor.hash}, now())
    ON CONFLICT (chain_id, stream) DO UPDATE SET last_block = EXCLUDED.last_block, last_hash = EXCLUDED.last_hash, updated_at = now()`;
}

// ------------------------------------------------------------------ replay

interface StoredRawRow {
  readonly id: bigint;
  readonly block_number: bigint;
  readonly block_hash: string;
  readonly block_timestamp: bigint;
  readonly tx_hash: string;
  readonly tx_index: number;
  readonly log_index: number;
  readonly tx_from: string | null;
  readonly address: string;
  readonly contract: string;
  readonly topic0: string | null;
  readonly topic1: string | null;
  readonly topic2: string | null;
  readonly topic3: string | null;
  readonly data: string;
}

function asHex(value: string): Hex {
  if (!/^0x[0-9a-f]*$/.test(value)) throw new Error(`stored value is not lowercase hex: ${value}`);
  return `0x${value.slice(2)}`;
}

/** Re-decodes a stored log with the ABI of its recorded contract role. */
export function storedToEvent(chainId: number, row: StoredRawRow): IndexedEvent | null {
  if (!isContractKind(row.contract)) throw new Error(`unknown contract kind ${row.contract} in raw_events`);
  const topics = [row.topic0, row.topic1, row.topic2, row.topic3].filter((t): t is string => t !== null).map(asHex);
  const decoded = decodeLog(row.contract, topics, asHex(row.data));
  if (!decoded) return null;
  return {
    at: {
      chainId,
      blockNumber: row.block_number,
      blockHash: asHex(row.block_hash),
      blockTimestamp: row.block_timestamp,
      txHash: asHex(row.tx_hash),
      txIndex: row.tx_index,
      logIndex: row.log_index,
      txFrom: row.tx_from === null ? null : asHex(row.tx_from),
      address: asHex(row.address),
    },
    decoded,
  };
}

export interface RebuildResult {
  readonly state: DerivedState;
  readonly violations: readonly InvariantViolation[];
  readonly events: number;
}

/**
 * Deletes every derived row for the chain and folds the canonical raw events back through the
 * reducers, in chain order. Run inside a transaction: readers see the old rows until commit.
 */
export async function rebuildDerived(q: Queryable, chainId: number, ctx: ReducerContext, pageSize = 5_000): Promise<RebuildResult> {
  for (const table of DERIVED_TABLES) await q`DELETE FROM ${q(TABLES[table].name)} WHERE chain_id = ${chainId}`;
  const state = emptyState();
  const violations: InvariantViolation[] = [];
  let events = 0;
  let after: { block: bigint; log: number } = { block: -1n, log: -1 };
  for (;;) {
    const rows = await q<StoredRawRow[]>`
      SELECT id, block_number, block_hash, block_timestamp, tx_hash, tx_index, log_index, tx_from, address, contract,
             topic0, topic1, topic2, topic3, data
      FROM raw_events
      WHERE chain_id = ${chainId} AND canonical
        AND (block_number, log_index) > (${after.block.toString()}, ${after.log})
      ORDER BY block_number, log_index
      LIMIT ${pageSize}`;
    if (rows.length === 0) break;
    const out = emptyOutput();
    for (const row of rows) {
      const ev = storedToEvent(chainId, row);
      if (ev) {
        applyEvent(state, ev, ctx, out);
        events += 1;
      }
    }
    await writeHistory(q, chainId, out.history);
    violations.push(...out.violations);
    const last = rows[rows.length - 1];
    if (!last) break;
    after = { block: last.block_number, log: last.log_index };
  }
  await writeState(q, chainId, state);
  return { state, violations, events };
}

export interface TableDigest {
  readonly rows: number;
  readonly sha256: string;
}

export interface DerivedSnapshot {
  readonly tables: Readonly<Record<string, TableDigest>>;
  readonly sha256: string;
}

/** Order-stable digest of every derived table for one chain, for replay-equivalence checks. */
export async function snapshotDerived(q: Queryable, chainId: number): Promise<DerivedSnapshot> {
  const tables: Record<string, TableDigest> = {};
  const all = createHash("sha256");
  for (const table of DERIVED_TABLES) {
    const spec = TABLES[table];
    const rows = await q`SELECT * FROM ${q(spec.name)} WHERE chain_id = ${chainId} ORDER BY ${q([...spec.key])}`;
    const body = JSON.stringify(rows, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    const sha256 = createHash("sha256").update(body).digest("hex");
    tables[spec.name] = { rows: rows.length, sha256 };
    all.update(`${spec.name}:${sha256};`);
  }
  return { tables, sha256: all.digest("hex") };
}
