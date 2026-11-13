import type { MerkleTree, Point, ShieldedDeposit } from "@rooq/private-sdk";
import { createPublicClient, erc20Abi, http, keccak256, parseAbi, parseAbiItem, toBytes, type Address, type Hex, type PublicClient } from "viem";
import { PRIVATE_READ_URL, PRIVATE_RELAYER_URL, PRIVATE_RPC_URL } from "./config";
import { MARKETS_ABI } from "./chain-state-abi";
import { FIXTURE_DISPLAY, keyForMarket } from "./markets";
import type { CreateInfo, MarketView, PoolView, PricePoint, TokenInfo } from "./types";

export const POOL_EVENTS = parseAbi([
  "event NullifiersSpent(bytes32[2] nullifiers)",
  "event RecordsConsumed(bytes32[] nullifiers)",
  "event ExitRequested(bytes32 indexed nullifier, address indexed requester, uint256 matureAt)",
  "event PairClosed(uint256 indexed market, bytes32 nullifier, uint256 mode, uint256 mark)",
  "event PairLiquidated(uint256 indexed market, bytes32 nullifier, uint256 mark)",
  "event Unshielded(address indexed asset, address indexed recipient, uint256 amount, address relayer, uint256 fee)",
]);
const FOLDED_ABI = parseAbi(["function foldedRatioPlusOne(bytes32) view returns (uint256)"]);
const POOL_READS = parseAbi([
  "function marketsModule() view returns (address)",
  "function oracle() view returns (address)",
  "function coordinatorX() view returns (uint256)",
  "function coordinatorY() view returns (uint256)",
  "function riskAX() view returns (uint256)",
  "function riskAY() view returns (uint256)",
  "function riskBX() view returns (uint256)",
  "function riskBY() view returns (uint256)",
  "struct Market { address asset; bytes32 feedId; uint256 scale; uint256 imrWad; uint256 mmrWad; uint256 penaltyBps; uint256 maxFundingPerHourWad; uint256 takerFeeBps; uint256 maxOiUsdWad; uint256 maxPairSize; }",
  "struct FundingState { uint256 index; uint256 lastEpoch; bytes32 head; uint256 consumed; }",
  "function market(uint256 id) view returns (Market)",
  "function funding(uint256 id) view returns (FundingState)",
]);
const ORACLE_READS = parseAbi([
  "function isApproved(bytes32 feedId) view returns (bool)",
  "function getPrice(bytes32 feedId) view returns (uint256 priceWad, uint256 updatedAt, bool fresh)",
  "function feedConfig(bytes32 feedId) view returns (address aggregator)",
]);
const FEED_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const ANSWER_EVENT = parseAbiItem("event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)");
const FUNDING_INDEX_ZERO = 1n << 128n;
const CREATED_EVENT = parseAbiItem("event MarketCreated(uint256 indexed market, address indexed creator, bytes32 feedId, uint256 tier, uint256 maxOiUsdWad, uint256 bond)");
/** Feeds this deployment's script approves for permissionless markets. Names are hashed on the oracle. */
const CREATABLE_FEEDS = (process.env.NEXT_PUBLIC_PRIVATE_CREATABLE_FEEDS ?? "ROOQ:private-v1:CREATABLE/USD").split(",").filter(Boolean);


export interface RecordRow {
  readonly leafIndex: number;
  readonly kind: number;
  readonly commitment: bigint;
  readonly ciphertext: readonly bigint[];
  readonly block: bigint;
}

export interface FundingEpoch {
  readonly index: bigint;
  readonly mark: bigint;
  readonly block: bigint;
  readonly asOf: number;
  readonly dt: bigint;
}

export interface Deployment {
  readonly id: bigint;
  readonly pool: Address;
  readonly spot: Address | null;
  readonly asset: Address;
  readonly feeTo: { readonly auth: bigint; readonly pk: Point };
  readonly exitBond: bigint;
  readonly startBlock: bigint;
}

export interface Spent {
  readonly block: bigint;
  readonly tx: Hex;
}

export interface PairEnd extends Spent {
  readonly kind: "closed" | "liquidated";
  readonly mark: bigint;
  readonly mode: bigint | null;
}

export interface Unshield extends Spent {
  readonly asset: Hex;
  readonly recipient: Hex;
  readonly amount: bigint;
}

export class ServiceDown extends Error {
  constructor(readonly service: "read" | "relayer" | "rpc", readonly detail: string) {
    super(`${service}: ${detail}`);
  }
}

/** Blocks per log request. Robinhood Chain makes about 500,000 blocks a day, so small ranges make the first load slow. */
const LOG_SPAN = 500_000n;
const MIN_LOG_SPAN = 2_000n;
/** The chart needs about a day of oracle updates, not every update since deployment. */
const PRICE_LOOKBACK_BLOCKS = 600_000n;
const RPC_SOURCE = "rpc";

/**
 * Reads logs from `from` to `head` in large ranges, halving a range the RPC refuses. Returns the next block to read.
 * Logs are applied one whole range at a time, so a failure never leaves a range half read.
 */
async function scanLogs(from: bigint, head: bigint, read: (fromBlock: bigint, toBlock: bigint) => Promise<void>): Promise<bigint> {
  let span = LOG_SPAN;
  let next = from;
  while (next <= head) {
    const to = next + span - 1n > head ? head : next + span - 1n;
    try {
      await read(next, to);
    } catch (error) {
      if (span <= MIN_LOG_SPAN) throw error;
      span /= 2n;
      continue;
    }
    next = to + 1n;
  }
  return next;
}

export interface OperatorKeys {
  readonly coordinator: Point;
  readonly riskKeys: readonly [Point, Point];
}

async function fetchJson<T>(service: "read" | "relayer", url: string, init?: RequestInit, timeoutMs = 8_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch (error) {
    throw new ServiceDown(service, error instanceof Error ? error.message : "unreachable");
  }
  if (!res.ok) throw new ServiceDown(service, `${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const readJson = <T>(path: string): Promise<T> => fetchJson<T>("read", `${PRIVATE_READ_URL}${path}`);

async function pageAll<T>(path: string, from: number): Promise<{ items: T[]; next: number }> {
  const items: T[] = [];
  let cursor = from;
  for (;;) {
    const page = await readJson<{ items: T[]; nextFrom: number | null }>(`${path}?from=${cursor}&limit=256`);
    items.push(...page.items);
    if (page.nextFrom === null) return { items, next: items.length > 0 ? cursor + items.length : cursor };
    cursor = page.nextFrom;
  }
}

/**
 * Public chain data as this wallet sees it. Every lookup is a paged read of everything, so neither the read API nor the
 * RPC learns which leaf, nullifier or exit this wallet cares about. Spent status, exits and prices come from the read
 * API's `/v1/public`, which serves every visitor the same public log data in one request; the chain's own logs are the
 * fallback when it can't answer. Asking the read API by nullifier would hand it the wallet's nullifiers, so nothing does.
 */

interface PublicSnapshot {
  readonly head: string;
  readonly headTime: string | null;
  readonly nextFrom: string;
  readonly tokens: readonly { address: Address; symbol: string; name: string; decimals: number }[];
  readonly spent: readonly { nullifier: Hex; block: string; tx: Hex }[];
  readonly exits: readonly { nullifier: Hex; matureAt: string }[];
  readonly ends: readonly { nullifier: Hex; kind: "closed" | "liquidated"; mark: string; mode: string | null; block: string; tx: Hex }[];
  readonly unshields: readonly { asset: Hex; recipient: Hex; amount: string; block: string; tx: Hex }[];
  readonly prices: Readonly<Record<string, readonly PricePoint[]>>;
}

const PRICE_POINTS_KEPT = 2_000;
/** Tiers and creatable feeds change only by governance, so they're read at most this often. */
const CREATE_INFO_MS = 60_000;
export class ChainState {
  deployment: Deployment | null = null;
  tokens = new Map<string, TokenInfo>();
  pools: PoolView[] = [];
  markets: MarketView[] = [];
  create: CreateInfo | null = null;
  private marketsFrom: bigint | null = null;
  private createdMarkets: { id: bigint; feedId: Hex }[] = [];
  relayerFees: { asset: Hex; amount: bigint }[] = [];
  relayerFeeAddress: { auth: bigint; pk: Point } | null = null;
  records: RecordRow[] = [];
  deposits: (ShieldedDeposit & { block: bigint })[] = [];
  private treeState: MerkleTree | null = null;
  /** Built on first account sync: the tree hashes its empty levels, which needs the proving engine loaded. */
  get tree(): MerkleTree {
    if (!this.treeState) throw new Error("note tree used before the account synced");
    return this.treeState;
  }
  processed = 0;
  queueLength = 0;
  root: Hex | null = null;
  syncedBlock: bigint | null = null;
  head: bigint | null = null;
  chainNow: bigint | null = null;
  spent = new Map<string, Spent>();
  exits = new Map<string, bigint>();
  ends = new Map<string, PairEnd>();
  unshields: Unshield[] = [];
  funding = new Map<bigint, FundingEpoch[]>();
  private recordsFrom = 0;
  private depositsFrom = 0;
  private logsFrom: bigint | null = null;
  private reorgsSeen: number | null = null;
  private readonly client: PublicClient = createPublicClient({ transport: http(PRIVATE_RPC_URL, { timeout: 8_000, retryCount: 1 }) });
  private blockTimes = new Map<bigint, bigint>();
  relayerDown = false;
  private priceLogs = new Map<bigint, { from: bigint; points: PricePoint[] }>();
  private pricesSince = 0;
  private publicLoaded = false;
  private createLoadedAt = 0;

  /** One read-API request for the public data a page needs. False when the API can't answer, so the caller reads the chain. */
  private async loadPublic(): Promise<boolean> {
    let p: PublicSnapshot;
    try {
      p = await readJson<PublicSnapshot>(`/v1/public?from=${this.logsFrom ?? 0n}&pricesSince=${this.pricesSince}`);
    } catch (error) {
      if (!(error instanceof ServiceDown)) throw error;
      this.publicLoaded = false;
      return false;
    }
    // A read API that is still catching up after a restart has no block time yet: report it, so the caller reads the head from chain.
    if (p.headTime === null) {
      this.publicLoaded = false;
      return false;
    }
    this.head = BigInt(p.head);
    this.chainNow = BigInt(p.headTime);
    for (const t of p.tokens) {
      if (this.tokens.has(t.address.toLowerCase())) continue;
      const shown = FIXTURE_DISPLAY[t.symbol];
      this.tokens.set(t.address.toLowerCase(), { address: t.address, decimals: t.decimals, symbol: shown?.symbol ?? t.symbol, name: shown?.name ?? t.name });
    }
    for (const e of p.spent) this.spent.set(e.nullifier.toLowerCase(), { block: BigInt(e.block), tx: e.tx });
    for (const e of p.exits) this.exits.set(e.nullifier.toLowerCase(), BigInt(e.matureAt));
    for (const e of p.ends) this.ends.set(e.nullifier.toLowerCase(), { block: BigInt(e.block), tx: e.tx, kind: e.kind, mark: BigInt(e.mark), mode: e.mode === null ? null : BigInt(e.mode) });
    for (const e of p.unshields) this.unshields.push({ block: BigInt(e.block), tx: e.tx, asset: e.asset, recipient: e.recipient, amount: BigInt(e.amount) });
    for (const [id, points] of Object.entries(p.prices)) {
      const row = this.priceLogs.get(BigInt(id)) ?? { from: 0n, points: [] };
      row.points.push(...points);
      if (row.points.length > PRICE_POINTS_KEPT) row.points.splice(0, row.points.length - PRICE_POINTS_KEPT);
      this.priceLogs.set(BigInt(id), row);
      const last = points.at(-1);
      if (last && last.time > this.pricesSince) this.pricesSince = last.time;
    }
    this.logsFrom = BigInt(p.nextFrom);
    this.publicLoaded = true;
    return true;
  }

  private reset(): void {
    this.records = [];
    this.deposits = [];
    this.treeState = null;
    this.recordsFrom = 0;
    this.depositsFrom = 0;
    this.logsFrom = null;
    this.marketsFrom = null;
    this.createdMarkets = [];
    this.spent.clear();
    this.exits.clear();
    this.ends.clear();
    this.unshields = [];
    this.funding.clear();
  }

  private async loadDeployment(): Promise<void> {
    const d = await readJson<{
      pool: Address; asset: Address; spot: Address | null; deploymentId: string; startBlock: string; exitBond: string;
      feeTo: { auth: string; pk: { x: string; y: string } };
      spotTokens: Address[];
    }>("/v1/deployment");
    if (this.deployment && this.deployment.id !== BigInt(d.deploymentId)) this.reset();
    const point = (p: { x: string; y: string }): Point => ({ x: BigInt(p.x), y: BigInt(p.y) });
    this.deployment = {
      id: BigInt(d.deploymentId), pool: d.pool, spot: d.spot, asset: d.asset,
      feeTo: { auth: BigInt(d.feeTo.auth), pk: point(d.feeTo.pk) }, exitBond: BigInt(d.exitBond), startBlock: BigInt(d.startBlock),
    };
    await this.loadTokens([d.asset, ...d.spotTokens]);
  }

  /** Operator keys rotate on chain, so every proof reads them here and nothing keeps a copy (D-24). */
  async readOperatorKeys(): Promise<OperatorKeys> {
    const { client, deployment } = this;
    const read = (functionName: "coordinatorX" | "coordinatorY" | "riskAX" | "riskAY" | "riskBX" | "riskBY") => client.readContract({ address: deployment!.pool, abi: POOL_READS, functionName });
    const [cx, cy, ax, ay, bx, by] = await Promise.all([read("coordinatorX"), read("coordinatorY"), read("riskAX"), read("riskAY"), read("riskBX"), read("riskBY")]).catch((error: unknown) => {
      throw new ServiceDown(RPC_SOURCE, error instanceof Error ? error.message : "operator keys unavailable");
    });
    return { coordinator: { x: cx, y: cy }, riskKeys: [{ x: ax, y: ay }, { x: bx, y: by }] };
  }

  /** The price the contract would use right now, for checking an order at the moment it's placed. Null when the feed is stale. */
  async readMark(market: bigint): Promise<bigint | null> {
    const { client, deployment } = this;
    const feedId = this.markets.find((m) => m.id === market)?.feedId;
    if (!deployment || !feedId) return null;
    const oracle = await client.readContract({ address: deployment.pool, abi: POOL_READS, functionName: "oracle" });
    const [price, , fresh] = await client.readContract({ address: oracle, abi: ORACLE_READS, functionName: "getPrice", args: [feedId] });
    return fresh ? price : null;
  }

  private async loadTokens(addresses: readonly Address[]): Promise<void> {
    const unknown = addresses.filter((a) => !this.tokens.has(a.toLowerCase()));
    const loaded = await Promise.all(unknown.map(async (address) => {
      const [symbol, name, decimals] = await Promise.all([this.client.readContract({ address, abi: erc20Abi, functionName: "symbol" }), this.client.readContract({ address, abi: erc20Abi, functionName: "name" }), this.client.readContract({ address, abi: erc20Abi, functionName: "decimals" })]);
      const shown = FIXTURE_DISPLAY[symbol];
      return { address, decimals, symbol: shown?.symbol ?? symbol, name: shown?.name ?? name };
    })).catch((error: unknown) => {
      throw new ServiceDown(RPC_SOURCE, error instanceof Error ? error.message : "token metadata unavailable");
    });
    // In deployment order, so token lists read the same on every load.
    for (const t of loaded) this.tokens.set(t.address.toLowerCase(), t);
  }

  private async loadMarkets(): Promise<void> {
    interface MarketRow {
      market: string; asset: Address; feedId: Hex; scale: string; imrWad: string; mmrWad: string; penaltyBps: string; maxFundingPerHourWad: string; takerFeeBps: string; maxOiUsdWad: string; maxPairSize: string;
      funding: { index: string; lastEpoch: string; epochs: number }; mark: string; markFresh: boolean; markUpdatedAt: string;
    }
    const { markets } = await readJson<{ markets: MarketRow[] }>("/v1/markets");
    const now = this.chainNow;
    this.markets = markets.map((m) => ({
      id: BigInt(m.market), label: keyForMarket(BigInt(m.market)) ?? `Market ${m.market}`, collateral: m.asset, feedId: m.feedId, fundingPerSecondWad: null, history: [], mark: m.markFresh ? BigInt(m.mark) : null, markFresh: m.markFresh,
      markAgeSeconds: now !== null ? Math.max(0, Number(now - BigInt(m.markUpdatedAt))) : null, imrWad: BigInt(m.imrWad), mmrWad: BigInt(m.mmrWad), penaltyBps: BigInt(m.penaltyBps), scale: BigInt(m.scale), takerFeeBps: BigInt(m.takerFeeBps),
      maxPairSize: BigInt(m.maxPairSize), maxOiUsdWad: BigInt(m.maxOiUsdWad), maxFundingPerHourWad: BigInt(m.maxFundingPerHourWad), fundingIndex: BigInt(m.funding.index), fundingLastEpoch: BigInt(m.funding.lastEpoch), fundingEpochs: m.funding.epochs,
    }));
    for (const m of markets) {
      const id = BigInt(m.market);
      const known = this.funding.get(id)?.length ?? 0;
      if (known >= m.funding.epochs) continue;
      const res = await readJson<{ items: { index: string; mark: string; block: string; asOf: string; dt: string }[] }>(`/v1/markets/${m.market}/funding?from=0&limit=512`);
      this.funding.set(id, res.items.map((e) => ({ index: BigInt(e.index), mark: BigInt(e.mark), block: BigInt(e.block), asOf: Number(e.asOf), dt: BigInt(e.dt) })));
    }
    await this.loadCreatedMarkets();
    await this.loadPriceHistory();
    const pools = await readJson<{ spot: Address | null; pools: { id: string; token0: Hex; token1: Hex; feeBps: string; seeded: boolean }[] }>("/v1/spot/pools");
    const low = (x: Hex): Hex => `0x${x.slice(-40)}`;
    this.pools = pools.pools.map((p) => ({ id: BigInt(p.id), token0: low(p.token0), token1: low(p.token1), feeBps: BigInt(p.feeBps), seeded: p.seeded }));
  }

  /** Tiers come from the contract. Created markets are read from chain too, so one the services haven't listed still shows. */
  private async loadCreatedMarkets(): Promise<void> {
    const d = this.deployment!;
    const client = this.client;
    let registry: Address;
    try {
      if (this.create && Date.now() - this.createLoadedAt < CREATE_INFO_MS) {
        await this.addCreatedMarkets(this.create.module);
        return;
      }
      registry = await client.readContract({ address: d.pool, abi: POOL_READS, functionName: "marketsModule" });
      if (BigInt(registry) === 0n) return;
      const count = await client.readContract({ address: registry, abi: MARKETS_ABI, functionName: "tierCount" });
      const tiers = await Promise.all(Array.from({ length: Number(count) }, (_, i) => client.readContract({ address: registry, abi: MARKETS_ABI, functionName: "tier", args: [BigInt(i)] })));
      const oracle = await client.readContract({ address: d.pool, abi: POOL_READS, functionName: "oracle" });
      const feeds = await Promise.all(CREATABLE_FEEDS.map(async (name) => {
        const id = keccak256(toBytes(name));
        const [approved, taken] = await Promise.all([client.readContract({ address: oracle, abi: ORACLE_READS, functionName: "isApproved", args: [id] }), client.readContract({ address: registry, abi: MARKETS_ABI, functionName: "feedTaken", args: [id] })]);
        return { id, label: name.split(":").at(-1) ?? name, approved, taken };
      }));
      this.create = { module: registry, tiers: tiers.map((t, i) => ({ id: i, ...t })), feeds, collateral: d.asset };
      this.createLoadedAt = Date.now();
      await this.addCreatedMarkets(registry);
    } catch (error) {
      throw new ServiceDown(RPC_SOURCE, error instanceof Error ? error.message : "market registry unavailable");
    }
  }

  /** Markets created after deployment, found from their events and read once each. */
  private async addCreatedMarkets(registry: Address): Promise<void> {
    const d = this.deployment!;
    const client = this.client;
    try {
      const head = this.head ?? (await client.getBlockNumber({ cacheTime: 0 }));
      this.marketsFrom = await scanLogs(this.marketsFrom ?? d.startBlock, head, async (fromBlock, toBlock) => {
        const logs = await client.getLogs({ address: registry, event: CREATED_EVENT, fromBlock, toBlock });
        for (const l of logs) this.createdMarkets.push({ id: l.args.market!, feedId: l.args.feedId! });
      });
      if (this.createdMarkets.length === 0) return;
      const oracle = await client.readContract({ address: d.pool, abi: POOL_READS, functionName: "oracle" });
      for (const c of this.createdMarkets) {
        if (this.markets.some((m) => m.id === c.id)) continue;
        const [m, f, price] = await Promise.all([client.readContract({ address: d.pool, abi: POOL_READS, functionName: "market", args: [c.id] }), client.readContract({ address: d.pool, abi: POOL_READS, functionName: "funding", args: [c.id] }), client.readContract({ address: oracle, abi: ORACLE_READS, functionName: "getPrice", args: [c.feedId] })]);
        this.markets.push({
          id: c.id, label: keyForMarket(c.id) ?? `Market ${c.id}`, collateral: m.asset, feedId: c.feedId, fundingPerSecondWad: null, history: [], mark: price[2] ? price[0] : null, markFresh: price[2], markAgeSeconds: this.chainNow !== null ? Math.max(0, Number(this.chainNow - price[1])) : null,
          imrWad: m.imrWad, mmrWad: m.mmrWad, penaltyBps: m.penaltyBps, scale: m.scale, takerFeeBps: m.takerFeeBps, maxPairSize: m.maxPairSize, maxOiUsdWad: m.maxOiUsdWad, maxFundingPerHourWad: m.maxFundingPerHourWad, fundingIndex: f.index, fundingLastEpoch: f.lastEpoch, fundingEpochs: 0,
        });
      }
    } catch (error) {
      throw new ServiceDown(RPC_SOURCE, error instanceof Error ? error.message : "market registry unavailable");
    }
  }

  /** Public oracle updates, for the chart. One price everywhere: the private market's own feed. */
  private async loadPriceHistory(): Promise<void> {
    const d = this.deployment!;
    const client = this.client;
    if (this.publicLoaded) {
      this.markets = this.markets.map((m) => this.withHistory(m, this.priceLogs.get(m.id)?.points ?? []));
      return;
    }
    try {
      const oracle = await client.readContract({ address: d.pool, abi: POOL_READS, functionName: "oracle" });
      const head = await client.getBlockNumber({ cacheTime: 0 });
      this.markets = await Promise.all(this.markets.map(async (m) => {
        const recent = head > PRICE_LOOKBACK_BLOCKS ? head - PRICE_LOOKBACK_BLOCKS : 0n;
        const row = this.priceLogs.get(m.id) ?? { from: d.startBlock > recent ? d.startBlock : recent, points: [] as PricePoint[] };
        const feed = await client.readContract({ address: oracle, abi: ORACLE_READS, functionName: "feedConfig", args: [m.feedId] }).catch(() => null);
        const decimals = feed ? await client.readContract({ address: feed, abi: FEED_ABI, functionName: "decimals" }) : 8;
        if (feed) {
          row.from = await scanLogs(row.from, head, async (fromBlock, toBlock) => {
            const logs = await client.getLogs({ address: feed, event: ANSWER_EVENT, fromBlock, toBlock });
            for (const l of logs) row.points.push({ time: Number(l.args.updatedAt), price: Number(l.args.current) / 10 ** decimals });
          });
          this.priceLogs.set(m.id, row);
        }
        return this.withHistory(m, row.points);
      }));
    } catch (error) {
      throw new ServiceDown(RPC_SOURCE, error instanceof Error ? error.message : "price history unavailable");
    }
  }

  /** The chart line and the funding rate, from oracle points, funding epochs and the current mark. */
  private withHistory(m: MarketView, points: readonly PricePoint[]): MarketView {
    const byTime = new Map(points.map((p) => [p.time, p]));
    for (const e of this.funding.get(m.id) ?? []) byTime.set(e.asOf, { time: e.asOf, price: Number(e.mark) / 1e18 });
    if (m.mark !== null && this.chainNow !== null) byTime.set(Number(this.chainNow), { time: Number(this.chainNow), price: Number(m.mark) / 1e18 });
    const history = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-1000);
    const epochs = this.funding.get(m.id) ?? [];
    const last = epochs.at(-1);
    const prev = epochs.at(-2)?.index ?? m.fundingIndex;
    const fundingPerSecondWad = last && last.dt > 0n && last.mark > 0n ? ((last.index - (epochs.length > 1 ? prev : FUNDING_INDEX_ZERO)) * 10n ** 18n) / last.mark / last.dt : null;
    return { ...m, history, fundingPerSecondWad };
  }

  private async loadRelayer(): Promise<void> {
    const info = await fetchJson<{ address: { auth: string; pk: { x: string; y: string } } | null; minimums: { asset: Hex; amount: string }[] }>("relayer", `${PRIVATE_RELAYER_URL}/v1/relayer`);
    this.relayerFees = info.minimums.map((m) => ({ asset: m.asset, amount: BigInt(m.amount) }));
    this.relayerFeeAddress = info.address ? { auth: BigInt(info.address.auth), pk: { x: BigInt(info.address.pk.x), y: BigInt(info.address.pk.y) } } : null;
  }

  private async syncTree(): Promise<void> {
    if (!this.treeState) {
      const { MerkleTree } = await import("@rooq/private-sdk");
      this.treeState = new MerkleTree();
    }
    for (;;) {
      const page = await readJson<{ leaves: Hex[]; processed: number; root: Hex }>(`/v1/tree/leaves?from=${this.tree.size}&limit=512`);
      for (const leaf of page.leaves) this.tree.insert(BigInt(leaf));
      this.processed = page.processed;
      if (page.leaves.length === 0 || this.tree.size >= page.processed) {
        this.root = page.root;
        return;
      }
    }
  }

  private async syncLogs(): Promise<void> {
    if (await this.loadPublic()) return;
    const d = this.deployment!;
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    const block = await this.client.getBlock({ blockNumber: head });
    this.head = head;
    this.chainNow = block.timestamp;
    this.logsFrom = await scanLogs(this.logsFrom ?? d.startBlock, head, async (fromBlock, toBlock) => {
      const logs = await this.client.getLogs({ address: d.pool, events: POOL_EVENTS, fromBlock, toBlock });
      for (const l of logs) {
        const at = { block: l.blockNumber, tx: l.transactionHash };
        if (l.eventName === "NullifiersSpent" || l.eventName === "RecordsConsumed") {
          for (const nf of l.args.nullifiers ?? []) this.spent.set(nf.toLowerCase(), at);
        } else if (l.eventName === "ExitRequested") {
          this.exits.set(l.args.nullifier!.toLowerCase(), l.args.matureAt!);
        } else if (l.eventName === "PairClosed") {
          this.ends.set(l.args.nullifier!.toLowerCase(), { ...at, kind: "closed", mark: l.args.mark!, mode: l.args.mode! });
        } else if (l.eventName === "PairLiquidated") {
          this.ends.set(l.args.nullifier!.toLowerCase(), { ...at, kind: "liquidated", mark: l.args.mark!, mode: null });
        } else if (l.eventName === "Unshielded") {
          this.unshields.push({ ...at, asset: l.args.asset!, recipient: l.args.recipient!, amount: l.args.amount! });
        }
      }
    });
  }

  /** What anyone can see with no account: market prices, pools and the current head. Pages no private data. */
  async syncPublic(): Promise<void> {
    const s = await readJson<{ syncedBlock: string | null; processed: number; queueLength: number; root: Hex }>("/v1/sync");
    this.syncedBlock = s.syncedBlock === null ? null : BigInt(s.syncedBlock);
    this.queueLength = s.queueLength;
    this.processed = s.processed;
    this.root = s.root;
    const fromApi = await this.loadPublic();
    await this.loadDeployment();
    if (!fromApi) {
      try {
        this.head = await this.client.getBlockNumber({ cacheTime: 0 });
        this.chainNow = (await this.client.getBlock({ blockNumber: this.head })).timestamp;
      } catch (error) {
        throw new ServiceDown(RPC_SOURCE, error instanceof Error ? error.message : "head unavailable");
      }
    }
    await this.loadMarkets();
    await this.loadRelayerStatus();
  }

  async sync(): Promise<void> {
    const s = await readJson<{ syncedBlock: string | null; head: string; processed: number; queueLength: number; root: Hex; reorgs: number }>("/v1/sync");
    if (this.reorgsSeen !== null && s.reorgs !== this.reorgsSeen) this.reset();
    this.reorgsSeen = s.reorgs;
    this.syncedBlock = s.syncedBlock === null ? null : BigInt(s.syncedBlock);
    this.queueLength = s.queueLength;
    if (this.tokens.size === 0) await this.loadPublic();
    await this.loadDeployment();
    const records = await pageAll<{ leafIndex: number; kind: number; commitment: Hex; ciphertext: Hex[]; block: string }>("/v1/records", this.recordsFrom);
    for (const r of records.items) this.records.push({ leafIndex: r.leafIndex, kind: r.kind, commitment: BigInt(r.commitment), ciphertext: r.ciphertext.map(BigInt), block: BigInt(r.block) });
    if (records.items.length > 0) this.recordsFrom = records.items.at(-1)!.leafIndex + 1;
    const deposits = await pageAll<{ leafIndex: number; asset: Hex; amount: string; inner: Hex; block: string }>("/v1/deposits", this.depositsFrom);
    for (const d of deposits.items) this.deposits.push({ leafIndex: d.leafIndex, asset: BigInt(d.asset), amount: BigInt(d.amount), inner: BigInt(d.inner), block: BigInt(d.block) });
    if (deposits.items.length > 0) this.depositsFrom = deposits.items.at(-1)!.leafIndex + 1;
    await this.syncTree();
    if (`0x${this.tree.root().toString(16).padStart(64, "0")}` !== this.root) {
      this.reset();
      throw new ServiceDown("read", "ROOT_MISMATCH");
    }
    try {
      await this.syncLogs();
    } catch (error) {
      if (error instanceof ServiceDown) throw error;
      throw new ServiceDown(RPC_SOURCE, error instanceof Error ? error.message : "log read failed");
    }
    await this.loadMarkets();
    await this.loadRelayerStatus();
  }

  /** A dead relayer must not stop a wallet reading its own balances: that's when it needs the direct exit most. */
  private async loadRelayerStatus(): Promise<void> {
    try {
      await this.loadRelayer();
      this.relayerDown = false;
    } catch (error) {
      if (!(error instanceof ServiceDown)) throw error;
      this.relayerDown = true;
    }
  }

  async foldedRatio(delta: Hex): Promise<bigint | null> {
    const r = await this.client.readContract({ address: this.deployment!.pool, abi: FOLDED_ABI, functionName: "foldedRatioPlusOne", args: [delta] });
    return r === 0n ? null : r - 1n;
  }

  fundingIndexAt(market: bigint, block: bigint): bigint | null {
    let at: bigint | null = null;
    for (const e of this.funding.get(market) ?? []) if (e.block <= block) at = e.index;
    return at;
  }

  async relaySend(action: string, body: string): Promise<{ id: Hex; status: string }> {
    const res = await fetch(`${PRIVATE_RELAYER_URL}/v1/relay/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(30_000) }).catch((error: unknown) => {
      throw new ServiceDown("relayer", error instanceof Error ? error.message : "unreachable");
    });
    const json = (await res.json()) as { id?: Hex; status?: string; reasonCode?: string; message?: string };
    if (!res.ok || !json.id) throw new RelayRefused(json.reasonCode ?? "RELAY_REFUSED", json.message ?? `Relayer answered ${res.status}`, res.status);
    return { id: json.id, status: json.status ?? "pending" };
  }

  async relayJob(id: Hex): Promise<{ status: string; reasonCode: string | null; tx: Hex | null; block: string | null; canRetry: boolean } | null> {
    const res = await fetch(`${PRIVATE_RELAYER_URL}/v1/jobs/${id}`, { signal: AbortSignal.timeout(8_000), cache: "no-store" }).catch((error: unknown) => {
      throw new ServiceDown("relayer", error instanceof Error ? error.message : "unreachable");
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new ServiceDown("relayer", `${res.status}`);
    return (await res.json()) as { status: string; reasonCode: string | null; tx: Hex | null; block: string | null; canRetry: boolean };
  }

  async receipt(hash: Hex): Promise<{ status: "success" | "reverted"; block: bigint } | null> {
    try {
      const r = await this.client.getTransactionReceipt({ hash });
      return { status: r.status, block: r.blockNumber };
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
      throw new ServiceDown(RPC_SOURCE, error instanceof Error ? error.message : "receipt unavailable");
    }
  }

  async blockTime(block: bigint): Promise<bigint | null> {
    const cached = this.blockTimes.get(block);
    if (cached !== undefined) return cached;
    const b = await this.client.getBlock({ blockNumber: block }).catch(() => null);
    if (!b) return null;
    this.blockTimes.set(block, b.timestamp);
    return b.timestamp;
  }
}

export class RelayRefused extends Error {
  constructor(readonly reason: string, message: string, readonly status: number) {
    super(message);
  }
}
