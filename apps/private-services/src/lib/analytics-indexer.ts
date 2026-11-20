import type { AdminIndexerState } from "@rooq/private-sdk/admin";
import { numberToHex, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import type { SyncProgress } from "./service";
import { decodeIndexedEvent, eventKind, topicOf, type AnalyticsEventName, type IndexedEvent, type RawLog } from "./analytics-events";
import { classifyCall, WALLET_ACTIONS, type ActionInfo } from "./analytics-selectors";
import { hourOf, type AnalyticsStore, type BlockRow, type EventSighting, type IndexBatch, type MarketCreatedRow, type OracleAnswer, type OracleGasSample, type ShieldRow, type TxRow, type UnshieldRow, type WalletSighting } from "./analytics-store";
import { errorMessage, type Logger } from "./log";

export interface ChainBlock {
  readonly hash: Hex;
  readonly time: number;
}

export interface ChainTx {
  readonly from: Address;
  readonly to: Address | null;
  readonly input: Hex;
}

export interface ChainReceipt {
  readonly from: Address;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly status: "success" | "reverted";
}

/** The few RPC reads the indexer makes, so tests can drive it with a fake chain. */
export interface IndexerChain {
  head(): Promise<bigint>;
  block(number: bigint): Promise<ChainBlock>;
  /** One address and one topic0 per call: the node refuses wide multi-address ranges but serves this over millions of blocks. */
  logs(address: Address, topic0: Hex, from: bigint, to: bigint): Promise<RawLog[]>;
  transaction(hash: Hex): Promise<ChainTx>;
  receipt(hash: Hex): Promise<ChainReceipt>;
}

export interface LogSource {
  readonly address: Address;
  readonly event: AnalyticsEventName;
}

export interface IndexerOptions {
  readonly startBlock: bigint;
  /** Blocks left unindexed behind the head, so ordinary reorgs never reach the index. */
  readonly finality: bigint;
  /**
   * Blocks per range. Lowered for the rest of the process when the node refuses a range as too wide; halved for the next
   * attempt when any other read fails, and grown back after each committed range, so a rate-limited node still lets
   * small ranges through instead of failing the same wide one forever.
   */
  readonly maxSpan: bigint;
  readonly minSpan: bigint;
  /** How far back to re-index when the cursor's block hash no longer matches the chain. */
  readonly reorgDepth: bigint;
  /** Time spent indexing per tick, so health stays fresh during a long backfill. */
  readonly budgetMs: number;
  /** Minimum time between catch-up rounds once the index is at the safe head. */
  readonly intervalMs: number;
  readonly concurrency: number;
}

/**
 * Errors that name the block range itself, such as the testnet node's "query spans 2797261 blocks … narrow the block
 * range". Rate limits ("request exceeds defined limit", "too many requests") must not match: they would lower the
 * ceiling for the rest of the process, while any other failure only shrinks the next attempt.
 */
export const RANGE_ERROR = /block range|range too (large|wide|big)|exceeds? .*range|query spans|response size|too many (results|logs)/i;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface Located {
  readonly log: RawLog;
  readonly event: IndexedEvent;
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Indexes public protocol events into the analytics store, from the deployment block up to the head minus a finality
 * margin. Each block range is fetched in full and then committed with the cursor in one transaction, so a restart
 * resumes from the last committed block and never counts a log twice.
 */
export class AnalyticsIndexer {
  private ceiling: bigint;
  private span: bigint;
  private headSeen = 0n;
  private updatedAt = 0;
  private catchingUp = true;
  private nextRunAt = 0;
  private reorgCount = 0;

  constructor(
    private readonly chain: IndexerChain,
    private readonly store: AnalyticsStore,
    private readonly sources: readonly LogSource[],
    private readonly selectors: ReadonlyMap<Hex, ActionInfo>,
    private readonly opts: IndexerOptions,
    private readonly log: Logger,
  ) {
    this.ceiling = opts.maxSpan;
    this.span = opts.maxSpan;
  }

  get reorgs(): number {
    return this.reorgCount;
  }

  private get indexedBlock(): bigint {
    const cursor = this.store.cursor();
    return cursor ? BigInt(cursor.block) : this.opts.startBlock - 1n;
  }

  state(): AdminIndexerState {
    const indexed = this.indexedBlock;
    return {
      indexedBlock: Number(indexed),
      head: Number(this.headSeen),
      lagBlocks: this.headSeen > indexed ? Number(this.headSeen - indexed) : 0,
      updatedAt: this.updatedAt,
      backfilling: this.catchingUp,
    };
  }

  progress(): SyncProgress {
    return { head: this.headSeen, syncedBlock: this.store.cursor() ? this.indexedBlock : null };
  }

  async tick(now = Date.now()): Promise<void> {
    if (!this.catchingUp && now < this.nextRunAt) return;
    this.nextRunAt = now + this.opts.intervalMs;
    this.headSeen = await this.chain.head();
    if (!(await this.checkReorg())) return;
    const target = this.headSeen - this.opts.finality;
    const deadline = Date.now() + this.opts.budgetMs;
    while (this.indexedBlock < target && Date.now() < deadline) {
      const from = this.indexedBlock + 1n;
      const to = from + this.span - 1n < target ? from + this.span - 1n : target;
      try {
        const logs = await this.collectLogs(from, to);
        if (logs === null) {
          this.ceiling = this.span = this.span / 2n > this.opts.minSpan ? this.span / 2n : this.opts.minSpan;
          this.log.info("analytics_span_narrowed", { span: this.span });
          continue;
        }
        await this.indexRange(from, to, logs);
      } catch (error) {
        this.shrinkAfterFailure();
        throw error;
      }
      this.span = this.span * 2n < this.ceiling ? this.span * 2n : this.ceiling;
    }
    this.catchingUp = this.indexedBlock < target;
    this.updatedAt = Math.floor(Date.now() / 1000);
  }

  private shrinkAfterFailure(): void {
    if (this.span <= this.opts.minSpan) return;
    this.span = this.span / 2n > this.opts.minSpan ? this.span / 2n : this.opts.minSpan;
    this.log.info("analytics_span_narrowed", { span: this.span, reason: "READ_FAILED" });
  }

  /**
   * The cursor block must still be on the chain with the hash stored for it. If not, the last `reorgDepth` blocks are
   * dropped and indexed again. When the newest block kept below that point has changed too, the fork is deeper than
   * `reorgDepth` and the index restarts from the deployment block. A head below the cursor is a lagging or
   * load-balanced RPC node, not a reorg (the cursor is already `finality` blocks behind), so that tick is skipped.
   * Returns false when the tick should not index.
   */
  private async checkReorg(): Promise<boolean> {
    const cursor = this.store.cursor();
    if (!cursor) return true;
    if (BigInt(cursor.block) > this.headSeen) {
      this.log.warn("analytics_rpc_behind", { head: this.headSeen, indexed: cursor.block });
      return false;
    }
    if (!(await this.hashChanged(cursor.block, cursor.hash))) return true;
    const floor = Number(this.opts.startBlock) - 1;
    let target = this.store.rollbackPoint(Math.max(floor, cursor.block - Number(this.opts.reorgDepth)));
    const kept = target > floor ? this.store.knownBlockAtOrBelow(target) : null;
    if (kept && (await this.hashChanged(kept.number, kept.hash))) target = floor;
    if (target <= floor) this.store.rollback(floor, null);
    else this.store.rollback(target, { block: target, hash: (await this.chain.block(BigInt(target))).hash });
    this.reorgCount++;
    this.log.warn("analytics_reorg", { from: cursor.block, to: target, rebuilt: target <= floor });
    return true;
  }

  /** A mismatch must hold on a second read, so one answer from an out-of-sync backend can't trigger a rollback. */
  private async hashChanged(block: number, stored: Hex): Promise<boolean> {
    for (let read = 0; read < 2; read++) {
      if ((await this.chain.block(BigInt(block))).hash.toLowerCase() === stored.toLowerCase()) return false;
    }
    return true;
  }

  /** Null when the node refused the range as too wide and it can still be narrowed. */
  private async collectLogs(from: bigint, to: bigint): Promise<RawLog[] | null> {
    try {
      const perSource = await mapLimit(this.sources, this.opts.concurrency, (s) => this.chain.logs(s.address, topicOf(s.event), from, to));
      return perSource.flat().sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    } catch (error) {
      if (this.span > this.opts.minSpan && RANGE_ERROR.test(errorMessage(error))) return null;
      throw error;
    }
  }

  private async indexRange(from: bigint, to: bigint, logs: readonly RawLog[]): Promise<void> {
    const located: Located[] = [];
    for (const log of logs) {
      try {
        located.push({ log, event: decodeIndexedEvent(log) });
      } catch (error) {
        this.log.warn("analytics_log_skipped", { block: log.blockNumber, tx: log.transactionHash, message: errorMessage(error) });
      }
    }
    const protocol = located.filter((l) => l.event.name !== "AnswerUpdated");

    const blocks = new Map<number, ChainBlock>();
    const newBlocks = [...new Set(protocol.map((l) => Number(l.log.blockNumber)))].filter((n) => this.store.blockTime(n) === null);
    const fetched = await mapLimit(newBlocks, this.opts.concurrency, (n) => this.chain.block(BigInt(n)));
    newBlocks.forEach((n, i) => blocks.set(n, fetched[i]!));
    const timeOf = (block: bigint): number => blocks.get(Number(block))?.time ?? this.store.blockTime(Number(block)) ?? 0;

    const txBlock = new Map<Hex, number>();
    for (const { log } of protocol) txBlock.set(log.transactionHash.toLowerCase() as Hex, Number(log.blockNumber));
    const newTxs = [...txBlock.keys()].filter((h) => !this.store.hasTx(h));
    const txInfo = await mapLimit(newTxs, this.opts.concurrency, (h) => Promise.all([this.chain.transaction(h), this.chain.receipt(h)]));

    const samples = new Map<string, { hour: number; feed: Address; log: RawLog }>();
    for (const { log, event } of located) {
      if (event.name !== "AnswerUpdated") continue;
      const hour = hourOf(Number(event.updatedAt));
      const key = `${hour}|${event.feed.toLowerCase()}`;
      if (!samples.has(key) && !this.store.hasOracleSample(hour, event.feed)) samples.set(key, { hour, feed: event.feed, log });
    }
    const sampleList = [...samples.values()];
    const sampleReceipts = await mapLimit(sampleList, this.opts.concurrency, (s) => this.chain.receipt(s.log.transactionHash));

    const end = blocks.get(Number(to)) ?? (await this.chain.block(to));

    const txs: TxRow[] = newTxs.map((hash, i) => {
      const [tx, receipt] = txInfo[i]!;
      const block = txBlock.get(hash)!;
      const call = classifyCall(this.selectors, tx.input);
      return {
        hash, block, time: timeOf(BigInt(block)), from: tx.from, to: tx.to, selector: call.selector, action: call.action, category: call.category,
        gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, reverted: receipt.status === "reverted",
      };
    });

    const shields: ShieldRow[] = [];
    const unshields: UnshieldRow[] = [];
    const marketsCreated: MarketCreatedRow[] = [];
    const wallets: WalletSighting[] = [];
    const events: EventSighting[] = [];
    const prices: OracleAnswer[] = [];
    for (const { log, event } of located) {
      const block = Number(log.blockNumber);
      const time = event.name === "AnswerUpdated" ? Number(event.updatedAt) : timeOf(log.blockNumber);
      events.push({ kind: eventKind(event), block, time });
      const at = { block, logIndex: log.logIndex, tx: log.transactionHash, time };
      switch (event.name) {
        case "Shielded":
          shields.push({ ...at, asset: event.asset, amount: event.amount, from: event.from });
          wallets.push({ address: event.from, block, time, source: "shield" });
          break;
        case "Unshielded":
          unshields.push({ ...at, asset: event.asset, recipient: event.recipient, amount: event.amount, relayer: event.relayer, fee: event.fee });
          wallets.push({ address: event.recipient, block, time, source: "unshield" });
          break;
        case "MarketCreated":
          marketsCreated.push({ market: Number(event.market), creator: event.creator, tier: event.tier, bond: event.bond, block, time });
          wallets.push({ address: event.creator, block, time, source: "market" });
          break;
        case "BondReleased":
          wallets.push({ address: event.creator, block, time, source: "market" });
          break;
        case "AnswerUpdated":
          prices.push({ feed: event.feed, answer: event.answer, updatedAt: time, block, logIndex: log.logIndex });
          break;
        default:
          break;
      }
    }
    for (const t of txs) if (WALLET_ACTIONS.has(t.action)) wallets.push({ address: t.from, block: t.block, time: t.time, source: "direct" });

    const oracleGas: OracleGasSample[] = sampleList.map((s, i) => {
      const r = sampleReceipts[i]!;
      return { hour: s.hour, feed: s.feed, from: r.from, feeWei: r.gasUsed * r.effectiveGasPrice, block: Number(s.log.blockNumber) };
    });

    const blockRows: BlockRow[] = [...blocks].map(([number, b]) => ({ number, hash: b.hash, time: b.time }));
    const batch: IndexBatch = { blocks: blockRows, txs, shields, unshields, marketsCreated, wallets: wallets.filter((w) => w.address.toLowerCase() !== ZERO_ADDRESS), events, oracleGas, prices };
    this.store.commit(batch, { from: Number(from), to: Number(to), hash: end.hash });
    if (located.length > 0) this.log.debug("analytics_indexed", { from, to, logs: located.length, txs: txs.length });
  }
}

/** The viem-backed chain. Logs are read raw, one address and one topic, and decoded by the indexer. */
export function viemIndexerChain(client: PublicClient<Transport, Chain>): IndexerChain {
  return {
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    async block(number) {
      const b = await client.getBlock({ blockNumber: number });
      return { hash: b.hash, time: Number(b.timestamp) };
    },
    async logs(address, topic0, from, to) {
      const rows = await client.request({ method: "eth_getLogs", params: [{ address, topics: [topic0], fromBlock: numberToHex(from), toBlock: numberToHex(to) }] });
      const out: RawLog[] = [];
      for (const r of rows) {
        if (r.blockNumber === null || r.logIndex === null || r.transactionHash === null) continue;
        out.push({ address: r.address, topics: r.topics, data: r.data, blockNumber: BigInt(r.blockNumber), logIndex: Number(r.logIndex), transactionHash: r.transactionHash });
      }
      return out;
    },
    async transaction(hash) {
      const t = await client.getTransaction({ hash });
      return { from: t.from, to: t.to, input: t.input };
    },
    async receipt(hash) {
      const r = await client.getTransactionReceipt({ hash });
      return { from: r.from, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, status: r.status };
    },
  };
}
