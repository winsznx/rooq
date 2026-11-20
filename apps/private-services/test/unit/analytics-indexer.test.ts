import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, numberToHex, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { ANALYTICS_EVENTS, topicOf, type RawLog } from "../../src/lib/analytics-events";
import { AnalyticsIndexer, type ChainBlock, type ChainReceipt, type ChainTx, type IndexerChain, type IndexerOptions, type LogSource } from "../../src/lib/analytics-indexer";
import { OperatorBook } from "../../src/lib/analytics-operators";
import { AdminReports } from "../../src/lib/analytics-report";
import { parseWindow } from "../../src/lib/analytics-series";
import { AnalyticsStore } from "../../src/lib/analytics-store";
import { buildSelectorMap } from "../../src/lib/analytics-selectors";
import { TokenBook } from "../../src/lib/analytics-tokens";
import { createLogger } from "../../src/lib/log";

const POOL: Address = "0x6b3dEA9d7C3FaCbFd8Eb78c101f0C0fF45648DF5";
const FEED: Address = "0x6266a7d494fD35aEC096aBf2De04c2A814220BDf";
const USDG: Address = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
const ALICE: Address = "0x364d832497792553BEE55c531344510B8Ca52657";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
const CAROL: Address = "0x00000000000000000000000000000000000ca201";
const COORDINATOR: Address = "0x0ec52416cd54be1dced168a1029004fc631e0ff5";
const RELAY: Address = "0x109204c94872210cC9D666A284Ba4069c6DE2E55";

const START = 100n;
/** Hour-aligned, ten minutes per block: blocks 100-105 are hour 0, 106-111 hour 1, 112-117 hour 2. */
const T0 = 1_800_000_000 - (1_800_000_000 % 3_600);
const timeOf = (block: bigint): number => T0 + Number(block - START) * 600;

const FUNCTIONS = parseAbi(["function shield(address asset, uint256 amount, bytes32 inner)", "function openPair(bytes proof)"]);
const SHIELD = toFunctionSelector(FUNCTIONS[0]);
const OPEN_PAIR = toFunctionSelector(FUNCTIONS[1]);

const SOURCES: LogSource[] = [
  { address: POOL, event: "Shielded" },
  { address: POOL, event: "PairOpened" },
  { address: FEED, event: "AnswerUpdated" },
];

const OPTIONS: IndexerOptions = { startBlock: START, finality: 2n, maxSpan: 8n, minSpan: 2n, reorgDepth: 5n, budgetMs: 10_000, intervalMs: 0, concurrency: 2 };

interface FakeTx {
  readonly tx: ChainTx;
  readonly receipt: ChainReceipt;
}

/** A chain whose blocks, logs and transactions are plain maps, with forks made by changing hashes from a block on. */
class FakeChain implements IndexerChain {
  headBlock = 120n;
  logList: RawLog[] = [];
  readonly txs = new Map<Hex, FakeTx>();
  private readonly forks = new Map<bigint, number>();
  /** The node refuses getLogs over more blocks than this, like the testnet node does past 100k. */
  maxLogSpan: bigint | null = null;
  receiptsFetched = 0;
  /** Receipts served before the node starts answering like a rate-limited public RPC. Null for no limit. */
  receiptBudget: number | null = null;
  /** Block reads answered with a wrong hash before the node answers truthfully, like an out-of-sync backend. */
  staleHashes = 0;
  /** Messages the next getLogs calls fail with, one per call. */
  readonly logFailures: string[] = [];
  logCalls = 0;
  private nextTx = 1;

  fork(from: bigint, id: number): void {
    for (let b = from; b <= this.headBlock + 100n; b++) this.forks.set(b, id);
  }

  head(): Promise<bigint> {
    return Promise.resolve(this.headBlock);
  }

  block(number: bigint): Promise<ChainBlock> {
    if (number > this.headBlock) return Promise.reject(new Error(`block ${number} not found`));
    let fork = this.forks.get(number) ?? 0;
    if (this.staleHashes > 0) {
      this.staleHashes--;
      fork = 9;
    }
    return Promise.resolve({ hash: numberToHex(number + BigInt(fork) * 1_000_000n, { size: 32 }), time: timeOf(number) });
  }

  logs(address: Address, topic0: Hex, from: bigint, to: bigint): Promise<RawLog[]> {
    this.logCalls++;
    const failure = this.logFailures.shift();
    if (failure !== undefined) return Promise.reject(new Error(failure));
    if (this.maxLogSpan !== null && to - from + 1n > this.maxLogSpan) return Promise.reject(new Error("query spans too many blocks, narrow the block range"));
    return Promise.resolve(this.logList.filter((l) => l.address === address && l.topics[0] === topic0 && l.blockNumber >= from && l.blockNumber <= to && l.blockNumber <= this.headBlock));
  }

  transaction(hash: Hex): Promise<ChainTx> {
    const t = this.txs.get(hash);
    return t ? Promise.resolve(t.tx) : Promise.reject(new Error(`tx ${hash} not found`));
  }

  receipt(hash: Hex): Promise<ChainReceipt> {
    if (this.receiptBudget !== null && this.receiptBudget-- <= 0) return Promise.reject(new Error("HTTP request failed. Status: 429"));
    this.receiptsFetched++;
    const t = this.txs.get(hash);
    return t ? Promise.resolve(t.receipt) : Promise.reject(new Error(`receipt ${hash} not found`));
  }

  private send(from: Address, input: Hex): Hex {
    const hash = numberToHex(this.nextTx++, { size: 32 });
    this.txs.set(hash, { tx: { from, to: POOL, input }, receipt: { from, gasUsed: 100_000n, effectiveGasPrice: 10n, status: "success" } });
    return hash;
  }

  shield(block: bigint, from: Address, amount: bigint): void {
    const topics = encodeEventTopics({ abi: ANALYTICS_EVENTS, eventName: "Shielded", args: { leafIndex: BigInt(this.nextTx), asset: USDG, from } }) as Hex[];
    const data = encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [amount, numberToHex(1n, { size: 32 })]);
    this.logList.push({ address: POOL, topics, data, blockNumber: block, logIndex: 0, transactionHash: this.send(from, `${SHIELD}00`) });
  }

  pairOpened(block: bigint, market: bigint): void {
    const topics = encodeEventTopics({ abi: ANALYTICS_EVENTS, eventName: "PairOpened", args: { market } }) as Hex[];
    const data = encodeAbiParameters([{ type: "bytes32" }], [numberToHex(2n, { size: 32 })]);
    this.logList.push({ address: POOL, topics, data, blockNumber: block, logIndex: 1, transactionHash: this.send(COORDINATOR, `${OPEN_PAIR}00`) });
  }

  answer(block: bigint, current = 1n): void {
    const topics = encodeEventTopics({ abi: ANALYTICS_EVENTS, eventName: "AnswerUpdated", args: { current, roundId: block } }) as Hex[];
    const data = encodeAbiParameters([{ type: "uint256" }], [BigInt(timeOf(block))]);
    this.logList.push({ address: FEED, topics, data, blockNumber: block, logIndex: 0, transactionHash: this.send(RELAY, "0x99213cd8") });
  }

  drop(block: bigint): void {
    this.logList = this.logList.filter((l) => l.blockNumber !== block);
  }
}

const log = createLogger("analytics-test");

/** Deps the money, vault and token slices add; these tests don't exercise them. */
const PRICING = {
  stableAsset: USDG,
  feeds: () => [],
  vault: { snapshot: () => Promise.reject(new Error("no vault in this test")) },
  token: null,
};

function setup(): { chain: FakeChain; store: AnalyticsStore; indexer: AnalyticsIndexer } {
  const chain = new FakeChain();
  chain.shield(103n, ALICE, 5_000_000n);
  chain.answer(104n);
  chain.pairOpened(105n, 1n);
  chain.answer(110n);
  chain.pairOpened(112n, 2n);
  chain.answer(116n);
  chain.shield(117n, BOB, 7_000_000n);
  const store = new AnalyticsStore(":memory:");
  return { chain, store, indexer: new AnalyticsIndexer(chain, store, SOURCES, buildSelectorMap(FUNCTIONS), OPTIONS, log) };
}

const total = (store: AnalyticsStore, prefix: string): number => store.eventTotals(0, prefix).reduce((s, r) => s + r.n, 0);

describe("analytics indexer", () => {
  test("indexes from the deployment block to the head minus the finality margin", async () => {
    const { chain, store, indexer } = setup();
    await indexer.tick();
    expect(store.cursor()?.block).toBe(118);
    expect(indexer.state()).toMatchObject({ indexedBlock: 118, head: 120, lagBlocks: 2, backfilling: false });
    expect(indexer.progress()).toEqual({ head: 120n, syncedBlock: 118n });
    expect(store.shieldAmounts(0).map((r) => r.amount)).toEqual(["5000000", "7000000"]);
    expect(total(store, "AnswerUpdated:")).toBe(3);
    expect(total(store, "PairOpened:")).toBe(2);
    expect(store.actionCounts(0)).toEqual([{ action: "openPair", category: "maintenance", n: 2, reverted: 0 }, { action: "shield", category: "user", n: 2, reverted: 0 }]);
    expect(store.walletCount(0, [])).toBe(2);
    expect(chain.receiptsFetched).toBe(4 + 3);
  });

  test("oracle writes are counted from events and one receipt is sampled per feed per hour", async () => {
    const { chain, store, indexer } = setup();
    chain.answer(115n);
    await indexer.tick();
    expect(total(store, "AnswerUpdated:")).toBe(4);
    expect(store.oracleWrites(0)).toEqual([{ from: RELAY.toLowerCase(), feeWei: 3n * 1_000_000n + 1_000_000n, n: 4, last: timeOf(116n) }]);
  });

  test("keeps each feed's last answer per hour for pricing flows", async () => {
    const { chain, store, indexer } = setup();
    chain.answer(117n, 25_000_000_000n);
    await indexer.tick();
    expect(store.oraclePrices()).toEqual([
      { hour: T0, feed: FEED.toLowerCase(), answer: "1" },
      { hour: T0 + 3_600, feed: FEED.toLowerCase(), answer: "1" },
      { hour: T0 + 7_200, feed: FEED.toLowerCase(), answer: "25000000000" },
    ]);
  });

  test("a restart with the same chain resumes without counting anything twice", async () => {
    const { chain, store, indexer } = setup();
    await indexer.tick();
    const restarted = new AnalyticsIndexer(chain, store, SOURCES, buildSelectorMap(FUNCTIONS), OPTIONS, log);
    await restarted.tick();
    chain.headBlock = 125n;
    chain.shield(122n, CAROL, 1n);
    await restarted.tick();
    expect(store.cursor()?.block).toBe(123);
    expect(total(store, "AnswerUpdated:")).toBe(3);
    expect(total(store, "Shielded")).toBe(3);
    expect(store.walletCount(0, [])).toBe(3);
  });

  test("halves the log range when the node refuses it, and still covers every block", async () => {
    const { chain, store, indexer } = setup();
    chain.maxLogSpan = 3n;
    await indexer.tick();
    expect(store.cursor()?.block).toBe(118);
    expect(total(store, "AnswerUpdated:")).toBe(3);
  });

  test("a rate limit on getLogs shrinks only the next attempt, never the range ceiling", async () => {
    const { chain, store, indexer } = setup();
    chain.logFailures.push("Request exceeds defined limit.");
    await expect(indexer.tick()).rejects.toThrow("exceeds defined limit");
    await Bun.sleep(0);
    chain.logCalls = 0;
    await indexer.tick();
    expect(store.cursor()?.block).toBe(118);
    expect(chain.logCalls).toBe(3 * SOURCES.length);
  });

  test("a rate-limited node still lets smaller ranges through, and nothing is counted twice", async () => {
    const { chain, store, indexer } = setup();
    let failures = 0;
    for (let round = 0; round < 20 && store.cursor()?.block !== 118; round++) {
      chain.receiptBudget = 2;
      await indexer.tick().catch(() => failures++);
    }
    expect(failures).toBeGreaterThan(0);
    expect(store.cursor()?.block).toBe(118);
    expect(total(store, "AnswerUpdated:")).toBe(3);
    expect(total(store, "PairOpened:")).toBe(2);
    expect(store.shieldAmounts(0).map((r) => r.amount)).toEqual(["5000000", "7000000"]);
  });

  test("a reorg past the cursor rolls back whole hours and re-indexes to the new chain exactly", async () => {
    const { chain, store, indexer } = setup();
    await indexer.tick();
    chain.fork(115n, 1);
    chain.drop(117n);
    chain.shield(116n, CAROL, 9n);
    chain.headBlock = 121n;
    await indexer.tick();
    expect(indexer.reorgs).toBe(1);
    expect(store.cursor()).toEqual({ block: 119, hash: (await chain.block(119n)).hash });
    expect(store.shieldAmounts(0).map((r) => r.amount)).toEqual(["5000000", "9"]);
    expect(total(store, "Shielded")).toBe(2);
    expect(total(store, "AnswerUpdated:")).toBe(3);
    expect(store.eventTotals(0, "PairOpened:").sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([{ kind: "PairOpened:1", n: 1 }, { kind: "PairOpened:2", n: 1 }]);
    expect(store.walletsBySource([]).reduce((s, r) => s + r.n, 0)).toBe(2);
    expect(store.walletCount(0, [BOB])).toBe(2);
  });

  test("a head below the cursor is a lagging node, so the tick is skipped without a rollback", async () => {
    const { chain, store, indexer } = setup();
    await indexer.tick();
    chain.headBlock = 110n;
    await indexer.tick();
    expect(indexer.reorgs).toBe(0);
    expect(store.cursor()?.block).toBe(118);
    expect(total(store, "AnswerUpdated:")).toBe(3);
  });

  test("one wrong hash from an out-of-sync backend doesn't roll anything back", async () => {
    const { chain, store, indexer } = setup();
    await indexer.tick();
    chain.staleHashes = 1;
    await indexer.tick();
    expect(indexer.reorgs).toBe(0);
    expect(store.cursor()).toEqual({ block: 118, hash: (await chain.block(118n)).hash });
  });

  test("a fork deeper than the reorg depth, here a chain reset, restarts the index once the head passes the cursor", async () => {
    const { chain, store, indexer } = setup();
    await indexer.tick();
    chain.headBlock = 110n;
    chain.fork(START, 2);
    await indexer.tick();
    expect(store.cursor()?.block).toBe(118);
    chain.headBlock = 130n;
    await indexer.tick();
    expect(indexer.reorgs).toBe(1);
    expect(store.cursor()).toEqual({ block: 128, hash: (await chain.block(128n)).hash });
    expect(store.shieldAmounts(0).map((r) => r.amount)).toEqual(["5000000", "7000000"]);
    expect(total(store, "AnswerUpdated:")).toBe(3);
  });
});

describe("admin reports over an indexed chain", () => {
  test("return counts and operator EOAs, never a user address", async () => {
    const { store, indexer } = setup();
    await indexer.tick();
    const operators = new OperatorBook([{ label: "price-relay", address: RELAY }, { label: "coordinator", address: "0x0Ec52416Cd54Be1DCed168A1029004FC631E0Ff5" }], {
      balance: () => Promise.resolve(10n ** 17n),
      nonce: (a, block) => Promise.resolve(block === 118n ? (a === RELAY ? 10 : 2) : 0),
    }, 1_000, log);
    await operators.refresh(BigInt(indexer.state().indexedBlock));
    const tokens = new TokenBook(() => Promise.resolve({ symbol: "USDG", decimals: 6 }), log);
    await tokens.load(store.flowAssets());
    const reports = new AdminReports({
      store, indexer, operators, tokens,
      services: { snapshot: () => Promise.resolve({ checkedAt: 0, services: [] }) },
      markets: () => [{ id: 1, symbol: "TSLA", feed: FEED }],
      pools: () => [],
      lastPriceAt: () => Promise.resolve(timeOf(116n)),
      ...PRICING,
    });
    const w = parseWindow(new URL("http://x/?range=all&bucket=hour"), timeOf(120n));
    const wallets = reports.wallets(w);
    const overview = await reports.overview(w);
    const ops = reports.operators(w);
    const bodies = JSON.stringify([wallets, overview, reports.actions(w), reports.flows(w), await reports.markets(w), reports.traffic(w)]).toLowerCase();
    for (const user of [ALICE, BOB]) expect(bodies).not.toContain(user.toLowerCase());
    expect(wallets).toMatchObject({ total: 2, newInRange: 2, bySource: [{ source: "shield", count: 2 }] });
    expect(wallets.cumulative.at(-1)?.v).toBe(2);
    expect(overview.shields).toEqual({ count: 2, byAsset: [{ asset: USDG, symbol: "USDG", decimals: 6, decimalsKnown: true, amount: "12000000" }] });
    expect(overview.txs).toEqual({ user: 2, maintenance: 2, oracle: 3, reverted: 0 });
    const relay = ops.operators.find((o) => o.label === "price-relay");
    expect(relay).toMatchObject({ nonce: 10, indexedTxs: 3, unindexedTxs: 7, gasSpentWei: (3n * 1_000_000n).toString(), actions: [{ action: "setAnswer", count: 3 }] });
    expect(ops.operators.find((o) => o.label === "coordinator")).toMatchObject({ indexedTxs: 2, unindexedTxs: 0, actions: [{ action: "openPair", count: 2 }] });
  });

  test("an asset whose decimals aren't read yet is flagged instead of shown as whole tokens", async () => {
    const { store, indexer } = setup();
    await indexer.tick();
    const reports = new AdminReports({
      store, indexer,
      operators: new OperatorBook([], { balance: () => Promise.resolve(0n), nonce: () => Promise.resolve(0) }, 1_000, log),
      tokens: new TokenBook(() => Promise.reject(new Error("decimals() reverted")), log),
      services: { snapshot: () => Promise.resolve({ checkedAt: 0, services: [] }) },
      markets: () => [],
      pools: () => [],
      lastPriceAt: () => Promise.resolve(null),
      ...PRICING,
    });
    const w = parseWindow(new URL("http://x/?range=all&bucket=hour"), timeOf(120n));
    expect((await reports.overview(w)).shields.byAsset).toEqual([{ asset: USDG, symbol: USDG, decimals: 0, decimalsKnown: false, amount: "12000000" }]);
    expect(reports.flows(w).shields.map((f) => f.decimalsKnown)).toEqual([false]);
  });

  test("operator nonces are read at the indexed block and skipped during a backfill", async () => {
    const reads: bigint[] = [];
    const book = new OperatorBook([{ label: "relayer", address: RELAY }], {
      balance: () => Promise.resolve(1n),
      nonce: (_address, block) => {
        reads.push(block);
        return Promise.resolve(7);
      },
    }, 1_000, log);
    await book.refresh(null, 0);
    expect(book.state(RELAY)).toEqual({ balanceWei: 1n, nonce: null, at: 0 });
    await book.refresh(118n, 1_000);
    await book.refresh(null, 2_000);
    expect(reads).toEqual([118n]);
    expect(book.state(RELAY)).toEqual({ balanceWei: 1n, nonce: 7, at: 2_000 });
  });
});
