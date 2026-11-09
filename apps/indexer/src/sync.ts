import type { Address, Hex, Log } from "viem";
import type { IndexerConfig } from "./config";
import { REDUCER_VERSION } from "./config";
import type { ChainContext } from "./chain";
import type { Db, Queryable } from "./db";
import { decodeLog, lower, toJson, type ContractKind, type DecodedEvent, type IndexedEvent, type LogPosition } from "./decode";
import { eventFacts } from "./facts";
import { debug, log, logError, warn } from "./log";
import { ensureMeta, loadMeta, type ContractMeta } from "./meta";
import { reconcile, summarise, type ReconcileResult } from "./reconcile";
import { applyEvent } from "./reducers";
import { cloneState, emptyOutput, type DerivedState, type InvariantViolation, type ReducerContext } from "./state";
import { CURSOR_STREAM, rebuildDerived, writeBatch, type BlockHeader, type RawEventInput } from "./store";
import {
  WatchList,
  deploymentTokens,
  deploymentWatchList,
  discoveredBy,
  loadDiscovered,
  reducerContext,
  saveWatched,
  tokensReferencedBy,
  type WatchEntry,
} from "./watch";

export interface Cursor {
  readonly block: bigint;
  readonly hash: Hex;
}

export type Linkage = { readonly ok: true } | { readonly ok: false; readonly reason: "parent-mismatch" | "gap" | "internal" };

/**
 * Pure: checks that `headers` (ascending, consecutive numbers) extend `cursor` and each other.
 * A mismatch against the cursor is a reorg below the range; an internal break means the node
 * reorganised while the range was being fetched and the range should simply be fetched again.
 */
export function checkLinkage(cursor: Cursor | null, headers: readonly BlockHeader[]): Linkage {
  const first = headers[0];
  if (!first) return { ok: true };
  if (cursor) {
    if (first.number !== cursor.block + 1n) return { ok: false, reason: "gap" };
    if (lower(first.parentHash) !== cursor.hash) return { ok: false, reason: "parent-mismatch" };
  }
  for (let i = 1; i < headers.length; i += 1) {
    const prev = headers[i - 1];
    const cur = headers[i];
    if (!prev || !cur || cur.number !== prev.number + 1n || lower(cur.parentHash) !== prev.hash) return { ok: false, reason: "internal" };
  }
  return { ok: true };
}

/**
 * Pure: given stored canonical hashes and the node's hashes for the same heights, returns the highest
 * height where they agree, or null when none of the supplied heights agree.
 */
export function commonAncestor(stored: ReadonlyMap<bigint, Hex>, chain: ReadonlyMap<bigint, Hex>): bigint | null {
  const heights = [...stored.keys()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  for (const n of heights) if (stored.get(n) === chain.get(n)) return n;
  return null;
}

export interface ReorgReport {
  readonly commonAncestor: bigint;
  readonly ancestorHash: Hex;
  readonly oldHead: bigint;
  readonly oldHeadHash: Hex;
  readonly newHead: bigint;
  readonly depth: number;
  readonly orphanedBlocks: number;
  readonly orphanedEvents: number;
}

export interface TickResult {
  readonly head: bigint;
  readonly cursor: Cursor | null;
  readonly progressed: boolean;
  readonly caughtUp: boolean;
  readonly indexedEvents: number;
  readonly reorg: ReorgReport | null;
  readonly reconciliation: ReconcileResult | null;
}

type HealthStatus = "ok" | "behind" | "degraded";

interface FetchedRange {
  readonly headers: readonly BlockHeader[];
  readonly logs: readonly Log[];
  readonly txFrom: ReadonlyMap<Hex, Address>;
  readonly discovered: readonly WatchEntry[];
}

type FetchOutcome = { readonly kind: "ok"; readonly range: FetchedRange } | { readonly kind: "reorg" } | { readonly kind: "retry"; readonly reason: string };

const RECONCILE_RETRY_MS = 10_000;

function isRangeLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /range|limit|too many|exceed|response size|query returned more/i.test(message);
}

export class Indexer {
  private state: DerivedState;
  private cursor: Cursor | null;
  private meta: Map<Address, ContractMeta>;
  private ctx: ReducerContext;
  private health: { status: HealthStatus; reason: string | null } = { status: "behind", reason: "starting" };
  private degradedReason: string | null = null;
  private lastReconcile: { block: bigint; ok: boolean; errored: boolean; at: number } | null = null;
  private lastReconciledBlock: bigint | null = null;

  private constructor(
    private readonly chain: ChainContext,
    private readonly sql: Db,
    private readonly config: IndexerConfig,
    private readonly watch: WatchList,
    init: { state: DerivedState; cursor: Cursor | null; meta: Map<Address, ContractMeta>; ctx: ReducerContext },
  ) {
    this.state = init.state;
    this.cursor = init.cursor;
    this.meta = init.meta;
    this.ctx = init.ctx;
  }

  get chainId(): number {
    return this.chain.deployment.chainId;
  }

  get currentCursor(): Cursor | null {
    return this.cursor;
  }

  get derived(): DerivedState {
    return this.state;
  }

  get reducerContext(): ReducerContext {
    return this.ctx;
  }

  /**
   * Verifies the database belongs to this chain (genesis hash), loads the watch list and contract
   * metadata and rebuilds derived state from canonical raw events. The first tick then checks the
   * stored cursor against the node (parent hash or tip hash) before indexing anything new.
   */
  static async open(chain: ChainContext, sql: Db, config: IndexerConfig): Promise<Indexer> {
    const dep = chain.deployment;
    const chainId = dep.chainId;
    const genesis = await chain.client.getBlock({ blockNumber: 0n });
    const genesisHash = lower(genesis.hash);
    const existing = await sql<{ genesis_hash: string; last_reconciled_block: bigint | null }[]>`
      SELECT genesis_hash, last_reconciled_block FROM indexer_status WHERE chain_id = ${chainId}`;
    const stored = existing[0];
    if (stored && stored.genesis_hash !== genesisHash) {
      throw new Error(
        `Database schema holds chain ${chainId} data for genesis ${stored.genesis_hash}, but the RPC genesis is ${genesisHash}. ` +
          `Point DATABASE_SCHEMA at an empty schema for this chain instance.`,
      );
    }

    const watch = new WatchList([...deploymentWatchList(dep), ...(await loadDiscovered(sql, chainId))]);
    let meta = await loadMeta(sql, chainId);
    meta = await ensureMeta(sql, chain.client, chainId, meta, { tokens: deploymentTokens(dep), feeds: watch.feeds() });
    const ctx = reducerContext(dep, meta);

    const rebuilt = await sql.begin((tx) => rebuildDerived(tx, chainId, ctx));
    const cursorRows = await sql<{ last_block: bigint; last_hash: Hex }[]>`
      SELECT last_block, last_hash FROM indexer_cursors WHERE chain_id = ${chainId} AND stream = ${CURSOR_STREAM}`;
    const c = cursorRows[0];
    const cursor: Cursor | null = c ? { block: c.last_block, hash: lower(c.last_hash) } : null;

    await sql`INSERT INTO indexer_status (chain_id, env, genesis_hash, deploy_block, status, reason, last_indexed_block, last_indexed_hash,
        reducer_version, started_at, updated_at)
      VALUES (${chainId}, ${chain.env}, ${genesisHash}, ${dep.deployBlock}, 'behind', 'starting',
        ${cursor ? cursor.block.toString() : null}, ${cursor?.hash ?? null}, ${REDUCER_VERSION}, now(), now())
      ON CONFLICT (chain_id) DO UPDATE SET env = EXCLUDED.env, deploy_block = EXCLUDED.deploy_block, status = 'behind', reason = 'starting',
        reducer_version = EXCLUDED.reducer_version, started_at = now(), updated_at = now()`;

    const indexer = new Indexer(chain, sql, config, watch, { state: rebuilt.state, cursor, meta, ctx });
    indexer.lastReconciledBlock = stored?.last_reconciled_block ?? null;
    if (rebuilt.violations.length > 0) indexer.recordViolations(rebuilt.violations);
    log("indexer_opened", {
      chainId,
      env: chain.env,
      schema: config.schema,
      genesis: genesisHash,
      cursor: cursor ? { block: cursor.block, hash: cursor.hash } : null,
      replayedEvents: rebuilt.events,
      watched: watch.all().length,
      reducerVersion: REDUCER_VERSION,
    });
    return indexer;
  }

  private recordViolations(violations: readonly InvariantViolation[]): void {
    for (const v of violations.slice(0, 20)) {
      warn("invariant_violation", { entity: v.entity, message: v.message, block: v.at.blockNumber, tx: v.at.txHash, logIndex: v.at.logIndex });
    }
    const first = violations[0];
    if (first) {
      this.degradedReason = `reducer invariant failed at block ${first.at.blockNumber} (${first.entity}): ${first.message}` +
        (violations.length > 1 ? ` (+${violations.length - 1} more)` : "");
    }
  }

  private statusFor(lag: bigint): { status: HealthStatus; reason: string | null } {
    if (this.degradedReason) return { status: "degraded", reason: this.degradedReason };
    if (lag > this.config.maxLagBlocks) return { status: "behind", reason: `${lag} blocks behind head` };
    return { status: "ok", reason: null };
  }

  private async writeStatus(q: Queryable, head: bigint, cursor: Cursor | null = this.cursor): Promise<void> {
    const last = cursor?.block ?? BigInt(this.chain.deployment.deployBlock) - 1n;
    this.health = this.statusFor(head > last ? head - last : 0n);
    await q`UPDATE indexer_status SET
        status = ${this.health.status},
        reason = ${this.health.reason},
        last_indexed_block = ${cursor ? cursor.block.toString() : null},
        last_indexed_hash = ${cursor?.hash ?? null},
        head_block = ${head.toString()},
        last_reconciled_block = ${this.lastReconciledBlock === null ? null : this.lastReconciledBlock.toString()},
        last_reconcile_ok = ${this.lastReconcile ? this.lastReconcile.ok : null},
        updated_at = now()
      WHERE chain_id = ${this.chainId}`;
  }

  /** One step: index the next bounded range, or detect a reorg, or reconcile when due. */
  async tick(): Promise<TickResult> {
    const client = this.chain.client;
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const none = { head, progressed: false, indexedEvents: 0, reconciliation: null } as const;

    if (this.cursor && head < this.cursor.block) {
      const reorg = await this.handleReorg(head);
      return { ...none, cursor: this.cursor, caughtUp: false, reorg };
    }
    if (this.cursor && head === this.cursor.block) {
      const tip = await client.getBlock({ blockNumber: head });
      if (lower(tip.hash) !== this.cursor.hash) {
        const reorg = await this.handleReorg(head);
        return { ...none, cursor: this.cursor, caughtUp: false, reorg };
      }
      const reconciliation = await this.maybeReconcile();
      await this.writeStatus(this.sql, head);
      return { ...none, cursor: this.cursor, caughtUp: true, reorg: null, reconciliation };
    }

    const deployBlock = BigInt(this.chain.deployment.deployBlock);
    const from = this.cursor ? this.cursor.block + 1n : deployBlock;
    if (from > head) {
      await this.writeStatus(this.sql, head);
      return { ...none, cursor: this.cursor, caughtUp: true, reorg: null };
    }
    const to = from + this.config.rangeBlocks - 1n < head ? from + this.config.rangeBlocks - 1n : head;
    const fetched = await this.fetchRange(from, to);
    if (fetched.kind === "reorg") {
      const reorg = await this.handleReorg(head);
      return { ...none, cursor: this.cursor, caughtUp: false, reorg };
    }
    if (fetched.kind === "retry") {
      warn("range_retry", { from, to, reason: fetched.reason });
      return { ...none, cursor: this.cursor, caughtUp: false, reorg: null };
    }
    const indexedEvents = await this.commitRange(fetched.range, head);
    const reconciliation = await this.maybeReconcile();
    if (reconciliation) await this.writeStatus(this.sql, head);
    return { head, cursor: this.cursor, progressed: true, caughtUp: to === head, indexedEvents, reorg: null, reconciliation };
  }

  private async getLogs(addresses: readonly Address[], from: bigint, to: bigint): Promise<Log[]> {
    if (addresses.length === 0) return [];
    try {
      return await this.chain.client.getLogs({ address: [...addresses], fromBlock: from, toBlock: to });
    } catch (error) {
      if (to > from && isRangeLimitError(error)) {
        const mid = from + (to - from) / 2n;
        warn("get_logs_split", { from, to, error: error instanceof Error ? error.message : String(error) });
        return [...(await this.getLogs(addresses, from, mid)), ...(await this.getLogs(addresses, mid + 1n, to))];
      }
      throw error;
    }
  }

  private kindOf(address: Address, pending: ReadonlyMap<Address, WatchEntry>): ContractKind | undefined {
    return this.watch.kindOf(address) ?? pending.get(address)?.kind;
  }

  private async fetchRange(from: bigint, to: bigint): Promise<FetchOutcome> {
    const client = this.chain.client;
    let logs = await this.getLogs(this.watch.addresses(to), from, to);

    // Pools and feeds announced inside the range are fetched for the rest of the range too.
    const pending = new Map<Address, WatchEntry>();
    for (let round = 0; round < 4; round += 1) {
      const fresh: WatchEntry[] = [];
      for (const l of logs) {
        const kind = this.kindOf(lower(l.address), pending);
        if (!kind || l.blockNumber === null) continue;
        const decoded = decodeLog(kind, l.topics, l.data);
        if (!decoded) continue;
        for (const entry of discoveredBy(decoded, l.blockNumber)) {
          if (!this.watch.has(entry.address) && !pending.has(entry.address)) {
            pending.set(entry.address, entry);
            fresh.push(entry);
          }
        }
      }
      if (fresh.length === 0) break;
      const extraFrom = fresh.reduce((min, e) => (e.fromBlock < min ? e.fromBlock : min), to);
      const extra = await this.getLogs(fresh.map((e) => e.address), extraFrom > from ? extraFrom : from, to);
      logs = [...logs, ...extra];
    }

    const unique = new Map<string, Log>();
    for (const l of logs) {
      if (l.blockHash === null || l.logIndex === null || l.blockNumber === null || l.transactionHash === null) {
        return { kind: "retry", reason: "node returned a pending log" };
      }
      unique.set(`${lower(l.blockHash)}:${l.logIndex}`, l);
    }
    const sorted = [...unique.values()].sort((a, b) =>
      a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : 1,
    );

    const withLogs = new Set(sorted.map((l) => l.blockNumber));
    const numbers: bigint[] = [];
    for (let n = from; n <= to; n += 1n) numbers.push(n);
    const blocks = await Promise.all(
      numbers.map((n) =>
        withLogs.has(n) ? client.getBlock({ blockNumber: n, includeTransactions: true }) : client.getBlock({ blockNumber: n }),
      ),
    );
    const headers: BlockHeader[] = [];
    const txFrom = new Map<Hex, Address>();
    for (const b of blocks) {
      if (b.hash === null || b.number === null) return { kind: "retry", reason: "node returned a pending block" };
      headers.push({ number: b.number, hash: lower(b.hash), parentHash: lower(b.parentHash), timestamp: b.timestamp });
      for (const t of b.transactions) if (typeof t !== "string") txFrom.set(lower(t.hash), lower(t.from));
    }

    const linkage = checkLinkage(this.cursor, headers);
    if (!linkage.ok) {
      if (linkage.reason === "parent-mismatch") return { kind: "reorg" };
      return { kind: "retry", reason: `header linkage broke inside the range (${linkage.reason})` };
    }
    const byNumber = new Map(headers.map((h) => [h.number, h.hash]));
    for (const l of sorted) {
      if (l.blockNumber === null || l.blockHash === null || byNumber.get(l.blockNumber) !== lower(l.blockHash)) {
        return { kind: "retry", reason: `log block hash differs from header at ${l.blockNumber}` };
      }
    }
    return { kind: "ok", range: { headers, logs: sorted, txFrom, discovered: [...pending.values()] } };
  }

  private toInputs(range: FetchedRange): { position: LogPosition; kind: ContractKind; log: Log; decoded: DecodedEvent | null }[] {
    const timestamps = new Map(range.headers.map((h) => [h.number, h.timestamp]));
    const pending = new Map(range.discovered.map((e) => [e.address, e]));
    const out: { position: LogPosition; kind: ContractKind; log: Log; decoded: DecodedEvent | null }[] = [];
    for (const l of range.logs) {
      const address = lower(l.address);
      const kind = this.kindOf(address, pending);
      if (!kind || l.blockNumber === null || l.blockHash === null || l.transactionHash === null || l.logIndex === null) continue;
      const timestamp = timestamps.get(l.blockNumber);
      if (timestamp === undefined) throw new Error(`missing header for block ${l.blockNumber}`);
      const txHash = lower(l.transactionHash);
      const decoded = decodeLog(kind, l.topics, l.data);
      if (!decoded) debug("undecoded_log", { address, topic0: l.topics[0] ?? null, block: l.blockNumber });
      out.push({
        position: {
          chainId: this.chainId,
          blockNumber: l.blockNumber,
          blockHash: lower(l.blockHash),
          blockTimestamp: timestamp,
          txHash,
          txIndex: l.transactionIndex ?? 0,
          logIndex: l.logIndex,
          txFrom: range.txFrom.get(txHash) ?? null,
          address,
        },
        kind,
        log: l,
        decoded,
      });
    }
    return out;
  }

  /** Reduces the range on a copy of the state and commits raw + derived rows + cursor atomically. */
  private async commitRange(range: FetchedRange, head: bigint): Promise<number> {
    const inputs = this.toInputs(range);
    const tokens = inputs.flatMap((i) => (i.decoded ? tokensReferencedBy(i.decoded) : []));
    const feeds = range.discovered.filter((e) => e.kind === "priceFeed").map((e) => e.address);
    if (tokens.length > 0 || feeds.length > 0) {
      this.meta = await ensureMeta(this.sql, this.chain.client, this.chainId, this.meta, { tokens, feeds });
      this.ctx = reducerContext(this.chain.deployment, this.meta);
    }

    const next = cloneState(this.state);
    const out = emptyOutput();
    const raw: RawEventInput[] = [];
    for (const input of inputs) {
      if (input.decoded) {
        const ev: IndexedEvent = { at: input.position, decoded: input.decoded };
        applyEvent(next, ev, this.ctx, out);
      }
      raw.push({
        at: input.position,
        contract: input.kind,
        topics: input.log.topics,
        data: input.log.data,
        decoded: input.decoded,
        facts: input.decoded ? eventFacts(input.decoded, input.position, next, this.ctx) : null,
      });
    }

    const last = range.headers[range.headers.length - 1];
    if (!last) throw new Error("empty range");
    const cursor: Cursor = { block: last.number, hash: last.hash };
    const logCounts = new Map<bigint, number>();
    for (const r of raw) logCounts.set(r.at.blockNumber, (logCounts.get(r.at.blockNumber) ?? 0) + 1);

    await this.sql.begin(async (tx) => {
      await writeBatch(tx, {
        chainId: this.chainId,
        blocks: range.headers,
        logCounts,
        raw,
        state: next,
        touched: out.touched,
        history: out.history,
        cursor,
      });
      if (range.discovered.length > 0) await saveWatched(tx, this.chainId, range.discovered);
      await this.writeStatus(tx, head, cursor);
    });
    this.cursor = cursor;
    this.state = next;
    for (const entry of range.discovered) this.watch.add(entry);
    if (out.violations.length > 0) this.recordViolations(out.violations);
    log("range_indexed", {
      from: range.headers[0]?.number ?? null,
      to: cursor.block,
      hash: cursor.hash,
      logs: raw.length,
      decoded: inputs.filter((i) => i.decoded).length,
      discovered: range.discovered.map((d) => d.address),
      head,
      status: this.health.status,
    });
    return raw.length;
  }

  /** Walks back to the highest block whose stored canonical hash the node still agrees with. */
  private async findAncestor(startAt: bigint): Promise<bigint | null> {
    const deployBlock = BigInt(this.chain.deployment.deployBlock);
    const oldest = this.cursor ? this.cursor.block - this.config.maxReorgDepth : deployBlock;
    let top = startAt;
    while (top >= deployBlock && top >= oldest) {
      const bottom = top - 63n > deployBlock ? top - 63n : deployBlock;
      const rows = await this.sql<{ number: bigint; hash: Hex }[]>`
        SELECT number, hash FROM chain_blocks
        WHERE chain_id = ${this.chainId} AND canonical AND number BETWEEN ${bottom.toString()} AND ${top.toString()}`;
      const stored = new Map(rows.map((r) => [r.number, lower(r.hash)]));
      const heights: bigint[] = [];
      for (let n = top; n >= bottom; n -= 1n) heights.push(n);
      const chainBlocks = await Promise.all(heights.map((n) => this.chain.client.getBlock({ blockNumber: n })));
      const chain = new Map<bigint, Hex>();
      for (const b of chainBlocks) if (b.number !== null && b.hash !== null) chain.set(b.number, lower(b.hash));
      const found = commonAncestor(stored, chain);
      if (found !== null) return found;
      top = bottom - 1n;
    }
    return top < deployBlock ? deployBlock - 1n : null;
  }

  /**
   * Marks every block and raw event above the common ancestor non-canonical, writes reorg tombstones
   * for streamed events, rebuilds derived state from the canonical events that remain and rewinds the
   * cursor. The next ticks then index the new branch forward from the ancestor.
   */
  async handleReorg(observedHead: bigint): Promise<ReorgReport> {
    const old = this.cursor;
    if (!old) throw new Error("reorg detected without a cursor");
    const startAt = observedHead < old.block ? observedHead : old.block;
    const ancestor = await this.findAncestor(startAt);
    if (ancestor === null) {
      this.degradedReason = `reorg deeper than INDEXER_MAX_REORG_DEPTH=${this.config.maxReorgDepth} below block ${old.block}`;
      await this.writeStatus(this.sql, observedHead);
      throw new Error(this.degradedReason);
    }
    const deployBlock = BigInt(this.chain.deployment.deployBlock);
    const ancestorRows =
      ancestor >= deployBlock
        ? await this.sql<{ hash: Hex }[]>`
            SELECT hash FROM chain_blocks WHERE chain_id = ${this.chainId} AND canonical AND number = ${ancestor.toString()}`
        : [];
    const ancestorHash: Hex = ancestorRows[0] ? lower(ancestorRows[0].hash) : `0x${"0".repeat(64)}`;

    const outcome = await this.sql.begin(async (tx) => {
      const blocks = await tx<{ hash: Hex }[]>`
        UPDATE chain_blocks SET canonical = false
        WHERE chain_id = ${this.chainId} AND canonical AND number > ${ancestor.toString()} RETURNING hash`;
      const events = await tx<{ id: bigint }[]>`
        UPDATE raw_events SET canonical = false
        WHERE chain_id = ${this.chainId} AND canonical AND block_number > ${ancestor.toString()} RETURNING id`;
      const orphanedHashes = blocks.map((b) => b.hash);
      if (orphanedHashes.length > 0) {
        await tx`
          INSERT INTO stream_events (chain_id, type, market_id, block_number, block_hash, tx_hash, log_index, event_id, reverted, payload)
          SELECT chain_id, type, market_id, block_number, block_hash, tx_hash, log_index, event_id, true, payload
          FROM (
            SELECT DISTINCT ON (event_id) *
            FROM stream_events
            WHERE chain_id = ${this.chainId} AND block_hash IN ${tx(orphanedHashes)}
            ORDER BY event_id, seq DESC
          ) latest
          WHERE NOT latest.reverted
          ORDER BY block_number, log_index`;
      }
      const r: ReorgReport = {
        commonAncestor: ancestor,
        ancestorHash,
        oldHead: old.block,
        oldHeadHash: old.hash,
        newHead: observedHead,
        depth: Number(old.block - ancestor),
        orphanedBlocks: blocks.length,
        orphanedEvents: events.length,
      };
      await tx`INSERT INTO reorgs (chain_id, common_ancestor, ancestor_hash, old_head, old_head_hash, new_head, depth, orphaned_blocks, orphaned_events)
        VALUES (${this.chainId}, ${ancestor.toString()}, ${ancestorHash}, ${old.block.toString()}, ${old.hash}, ${observedHead.toString()},
          ${r.depth}, ${r.orphanedBlocks}, ${r.orphanedEvents})`;
      const rebuilt = await rebuildDerived(tx, this.chainId, this.ctx);
      if (ancestor >= deployBlock) {
        await tx`UPDATE indexer_cursors SET last_block = ${ancestor.toString()}, last_hash = ${ancestorHash}, updated_at = now()
          WHERE chain_id = ${this.chainId} AND stream = ${CURSOR_STREAM}`;
      } else {
        await tx`DELETE FROM indexer_cursors WHERE chain_id = ${this.chainId} AND stream = ${CURSOR_STREAM}`;
      }
      await tx`UPDATE indexer_status SET reorg_count = reorg_count + 1 WHERE chain_id = ${this.chainId}`;
      const rewound: Cursor | null = ancestor >= deployBlock ? { block: ancestor, hash: ancestorHash } : null;
      await this.writeStatus(tx, observedHead, rewound);
      return { report: r, state: rebuilt.state, cursor: rewound };
    });
    this.state = outcome.state;
    this.cursor = outcome.cursor;
    if (this.lastReconciledBlock !== null && this.lastReconciledBlock > ancestor) this.lastReconciledBlock = null;
    this.lastReconcile = null;
    const report = outcome.report;
    warn("reorg_handled", { ...report });
    return report;
  }

  private reconcileDue(block: bigint): boolean {
    const last = this.lastReconcile;
    if (!last) return true;
    if (last.errored) return Date.now() - last.at >= RECONCILE_RETRY_MS;
    return block - last.block >= this.config.reconcileEveryBlocks;
  }

  private async maybeReconcile(): Promise<ReconcileResult | null> {
    if (!this.cursor || !this.reconcileDue(this.cursor.block)) return null;
    return this.reconcileNow();
  }

  /**
   * Reconciles derived state at the cursor block and persists the result. Mismatch => degraded.
   * `full` rechecks every pair and free balance instead of only those changed since the last pass.
   */
  async reconcileNow(opts: { full?: boolean } = {}): Promise<ReconcileResult | null> {
    const cursor = this.cursor;
    if (!cursor) return null;
    try {
      const result = await reconcile(this.chain.client, this.chain.deployment, this.state, cursor.block, {
        sinceBlock: opts.full ? null : this.lastReconciledBlock,
        maxPairs: 500,
        maxLedgerAccounts: 200,
      });
      await this.sql`INSERT INTO reconciliations (chain_id, block_number, block_hash, ok, checks, mismatches, details)
        VALUES (${this.chainId}, ${cursor.block.toString()}, ${cursor.hash}, ${result.ok}, ${result.checks}, ${result.mismatches.length},
          ${this.sql.json(toJson({ counts: result.counts, mismatches: result.mismatches.slice(0, 50), vaultSurplus: result.vaultSurplus, truncated: result.truncated }))})`;
      this.lastReconcile = { block: cursor.block, ok: result.ok, errored: false, at: Date.now() };
      if (result.ok) {
        this.lastReconciledBlock = cursor.block;
        this.degradedReason = null;
        log("reconciled", { block: cursor.block, checks: result.checks, counts: result.counts, vaultSurplus: result.vaultSurplus });
      } else {
        this.degradedReason = summarise(result);
        warn("reconciliation_mismatch", { block: cursor.block, mismatches: result.mismatches.slice(0, 10) });
      }
      return result;
    } catch (error) {
      logError("reconciliation_error", error, { block: cursor.block });
      this.lastReconcile = { block: cursor.block, ok: false, errored: true, at: Date.now() };
      this.degradedReason = `reconciliation at block ${cursor.block} could not run: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
      await this.sql`INSERT INTO reconciliations (chain_id, block_number, block_hash, ok, checks, mismatches, details, error)
        VALUES (${this.chainId}, ${cursor.block.toString()}, ${cursor.hash}, false, 0, 0, ${this.sql.json({})}, ${this.degradedReason})`;
      return null;
    }
  }

  /** Called by the loop when a tick throws, so the status row never claims "ok" during failures. */
  async recordFailure(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
    await this.sql`UPDATE indexer_status SET status = 'degraded', reason = ${`indexer error: ${message}`}, updated_at = now()
      WHERE chain_id = ${this.chainId}`;
  }

  /** Ticks until the cursor reaches the head observed at the start, or `maxTicks` is hit. */
  async catchUp(maxTicks = 1_000): Promise<TickResult[]> {
    const results: TickResult[] = [];
    for (let i = 0; i < maxTicks; i += 1) {
      const r = await this.tick();
      results.push(r);
      if (r.caughtUp && !r.reorg) break;
      if (!r.progressed && !r.reorg) await Bun.sleep(100);
    }
    return results;
  }
}
