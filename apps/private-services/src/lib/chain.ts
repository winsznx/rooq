import { readFileSync } from "node:fs";
import { CHAINS, MAINNET_CHAIN_ID_BLOCKED } from "@rooq/config";
import { type KeyRing, type Point, type PrivateAddress } from "@rooq/private-sdk";
import { ContractFunctionExecutionError, createPublicClient, defineChain, http, parseAbi, type Abi, type AbiItem, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { REPO_ROOT, type BaseConfig } from "./config";

export interface MarketInfo {
  readonly id: bigint;
  readonly asset: Address;
  readonly feedId: Hex;
  readonly scale: bigint;
  readonly imrWad: bigint;
  readonly mmrWad: bigint;
  readonly penaltyBps: bigint;
  readonly maxFundingPerHourWad: bigint;
  readonly takerFeeBps: bigint;
  readonly maxOiUsdWad: bigint;
  readonly maxPairSize: bigint;
}

export interface FundingState {
  readonly index: bigint;
  readonly lastEpoch: bigint;
  readonly head: bigint;
  readonly consumed: bigint;
}

export interface PriceRead {
  readonly price: bigint;
  readonly updatedAt: bigint;
  readonly fresh: boolean;
}

export interface DeploymentFile {
  readonly pool: Address;
  readonly asset: Address;
  readonly chainId: number;
  readonly startBlock: number | string;
  /** Absent on a deployment without the spot module. */
  readonly spot?: Address;
  readonly markets?: Address;
  readonly spotTokens?: readonly Address[];
  /** A feed approved for one permissionless market, relayed like the market feeds. */
  readonly thirdFeedId?: Hex;
}

export type KeySlot = "coordinator" | "riskA" | "riskB";

interface KeySetRead {
  readonly coordinator: Point;
  readonly riskA: Point;
  readonly riskB: Point;
}

export interface SpotPoolInfo {
  readonly id: bigint;
  readonly token0: bigint;
  readonly token1: bigint;
  readonly feeBps: bigint;
}

export const SPOT_FUNCTIONS: ReadonlySet<string> = new Set(["swap", "addLiquidity", "setLiquidityRequest", "removeLiquidity"]);
export const MARKETS_FUNCTIONS: ReadonlySet<string> = new Set(["redeemClaim", "sweepInsurance", "releaseBond", "closeToNewPositions", "created", "keyEpoch", "keySetAt", "pendingKeyRotation", "scheduleKeyRotation", "cancelKeyRotation", "activateKeyRotation"]);
const MARKETS_EVENTS: ReadonlySet<string> = new Set(["MarketCreated", "BondReleased", "MarketClosedToNewPositions"]);

const ARTIFACTS_WITH_ERRORS = ["OracleAdapter", ...["Append", "Spend", "Lock", "OpenPair", "Liquidate", "Release", "FundingEpoch", "ClosePair", "ExitRequest", "PairUpdate", "RedeemClaim", "InsuranceSweep"].map((n) => `${n}Verifier`)];

const artifactAbi = (out: string, name: string): Abi => (JSON.parse(readFileSync(`${out}/${name}.sol/${name}.json`, "utf8")) as { abi: Abi }).abi;

/** PrivatePairs ABI plus the custom errors its oracle and verifiers can bubble up, so every revert decodes to a name. */
export function loadPoolAbi(out = process.env.ARTIFACTS_OUT ?? `${REPO_ROOT}contracts/out`): Abi {
  const pool = artifactAbi(out, "PrivatePairs");
  const seen = new Set(pool.filter((i) => i.type === "error").map((i) => i.name));
  const extra: AbiItem[] = [];
  for (const name of ARTIFACTS_WITH_ERRORS) {
    for (const item of artifactAbi(out, name)) {
      if (item.type === "error" && !seen.has(item.name)) {
        seen.add(item.name);
        extra.push(item);
      }
    }
  }
  for (const item of artifactAbi(out, "PrivateSpot")) {
    if (item.type === "error" && !seen.has(item.name)) {
      seen.add(item.name);
      extra.push(item);
    } else if ((item.type === "event" && item.name === "PoolUpdated") || (item.type === "function" && (SPOT_FUNCTIONS.has(item.name) || item.name === "pool"))) {
      extra.push(item);
    }
  }
  for (const item of artifactAbi(out, "PrivateMarkets")) {
    if (item.type === "error" && !seen.has(item.name)) {
      seen.add(item.name);
      extra.push(item);
    } else if ((item.type === "event" && MARKETS_EVENTS.has(item.name)) || (item.type === "function" && MARKETS_FUNCTIONS.has(item.name))) {
      extra.push(item);
    }
  }
  return [...pool, ...extra];
}

const priceAbi = parseAbi(["function getPrice(bytes32 feedId) view returns (uint256 priceWad, uint256 updatedAt, bool fresh)"]);

const FIRST_CREATED_MARKET = 100n;

export class ChainContext {
  private keyEpochSeen: bigint | null = null;

  private constructor(
    readonly config: BaseConfig,
    readonly chain: Chain,
    readonly client: PublicClient<Transport, Chain>,
    readonly abi: Abi,
    readonly pool: Address,
    readonly asset: Address,
    readonly oracle: Address,
    readonly startBlock: bigint,
    readonly deploymentId: bigint,
    public coordinator: Point,
    public riskKeys: readonly [Point, Point],
    readonly feeTo: PrivateAddress,
    readonly exitBond: bigint,
    readonly markets: MarketInfo[],
    readonly spot: Address | null,
    readonly spotTokens: readonly Address[],
    readonly spotPools: readonly SpotPoolInfo[],
    readonly marketsModule: Address | null,
    private readonly rotationSupported: boolean,
  ) {}

  /** Refuses mainnet and any RPC that does not serve the configured chain, before a key is used. */
  static async open(config: BaseConfig): Promise<ChainContext> {
    const cfg = CHAINS[config.env];
    const chain = defineChain({ id: cfg.chainId, name: cfg.name, nativeCurrency: cfg.nativeCurrency, rpcUrls: { default: { http: [config.rpcUrl] } } });
    const client = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
    const actual = await client.getChainId();
    if (actual === MAINNET_CHAIN_ID_BLOCKED) throw new Error("Refusing to run against Robinhood Chain mainnet");
    if (actual !== cfg.chainId) throw new Error(`RPC chain id ${actual} does not match ${config.env} (${cfg.chainId})`);
    const deployment = JSON.parse(readFileSync(config.deploymentFile, "utf8")) as DeploymentFile;
    if (Number(deployment.chainId) !== actual) throw new Error(`Deployment file is for chain ${deployment.chainId}, RPC is ${actual}`);
    const abi = loadPoolAbi();
    const pool = deployment.pool;
    const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> => client.readContract({ address: pool, abi, functionName, args }) as Promise<T>;
    const [oracle, deploymentId, cx, cy, ax, ay, bx, by, feeAuth, feeX, feeY, exitBond] = await Promise.all([
      read<Address>("oracle"), read<bigint>("deploymentId"), read<bigint>("coordinatorX"), read<bigint>("coordinatorY"), read<bigint>("riskAX"), read<bigint>("riskAY"), read<bigint>("riskBX"), read<bigint>("riskBY"), read<bigint>("feeAuth"), read<bigint>("feeX"), read<bigint>("feeY"), read<bigint>("EXIT_BOND"),
    ]);
    const markets: MarketInfo[] = [];
    // Markets fixed at deployment have small sequential ids and no event; later ones are found from MarketCreated.
    for (let id = 1n; id < FIRST_CREATED_MARKET; id++) {
      const m = await read<Omit<MarketInfo, "id">>("market", [id]);
      if (BigInt(m.asset) === 0n) break;
      markets.push({ ...m, id });
    }
    if (markets.length === 0) throw new Error("Deployment has no markets");
    const spot = deployment.spot ?? null;
    const spotPools: SpotPoolInfo[] = [];
    if (spot) {
      for (let id = 1n; ; id++) {
        const p = (await client.readContract({ address: spot, abi, functionName: "pool", args: [id] })) as { token0: Address; token1: Address; feeBps: bigint };
        if (BigInt(p.token0) === 0n) break;
        spotPools.push({ id, token0: BigInt(p.token0), token1: BigInt(p.token1), feeBps: p.feeBps });
      }
    }
    const rotationSupported = deployment.markets ? await supportsRotation(client, deployment.markets, abi) : false;
    return new ChainContext(config, chain, client, abi, pool, deployment.asset, oracle, BigInt(deployment.startBlock), deploymentId, { x: cx, y: cy }, [{ x: ax, y: ay }, { x: bx, y: by }],
      { auth: feeAuth, pk: { x: feeX, y: feeY } }, exitBond, markets, spot, deployment.spotTokens ?? [], spotPools, deployment.markets ?? null, rotationSupported);
  }

  read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client.readContract({ address: this.pool, abi: this.abi, functionName, args }) as Promise<T>;
  }

  async funding(market: bigint): Promise<FundingState> {
    const s = await this.read<{ index: bigint; lastEpoch: bigint; head: Hex; consumed: bigint }>("funding", [market]);
    return { index: s.index, lastEpoch: s.lastEpoch, head: BigInt(s.head), consumed: s.consumed };
  }

  oiDeltaCount(market: bigint): Promise<bigint> {
    return this.read<bigint>("oiDeltaCount", [market]);
  }

  async oiDelta(market: bigint, index: bigint): Promise<bigint> {
    return BigInt(await this.read<Hex>("oiDelta", [market, index]));
  }

  async price(market: MarketInfo): Promise<PriceRead> {
    const [price, updatedAt, fresh] = await this.client.readContract({ address: this.oracle, abi: priceAbi, functionName: "getPrice", args: [market.feedId] });
    return { price, updatedAt, fresh };
  }

  async blockTime(): Promise<bigint> {
    return (await this.client.getBlock({ blockTag: "latest" })).timestamp;
  }

  /** Spot functions live on the spot module, everything else on the pool. */
  targetFor(functionName: string): Address {
    if (MARKETS_FUNCTIONS.has(functionName)) {
      if (!this.marketsModule) throw new Error("This deployment has no markets module");
      return this.marketsModule;
    }
    if (!SPOT_FUNCTIONS.has(functionName)) return this.pool;
    if (!this.spot) throw new Error("This deployment has no spot module");
    return this.spot;
  }

  /** Brings the created-market list in line with the chain, in both directions: a reorg can remove a MarketCreated. */
  async syncCreatedMarkets(created: readonly bigint[]): Promise<void> {
    const wanted = new Set(created);
    for (let i = this.markets.length - 1; i >= 0; i--) {
      const m = this.markets[i]!;
      if (m.id >= FIRST_CREATED_MARKET && !wanted.has(m.id)) this.markets.splice(i, 1);
    }
    for (const id of created) {
      if (this.market(id)) continue;
      const m = await this.read<Omit<MarketInfo, "id">>("market", [id]);
      if (BigInt(m.asset) !== 0n) this.markets.push({ ...m, id });
    }
  }

  /** Public by policy: a created market's bond, and whether its creator has stopped new positions. */
  async marketPolicy(market: bigint): Promise<{ bond: bigint; closeOnly: boolean }> {
    const [bond, closeOnly] = await Promise.all([this.read<bigint>("marketBond", [market]), this.read<boolean>("closeOnly", [market])]);
    return { bond, closeOnly };
  }

  async bondReleased(market: bigint): Promise<boolean> {
    if (!this.marketsModule) return true;
    const c = (await this.client.readContract({ address: this.marketsModule, abi: this.abi, functionName: "created", args: [market] })) as readonly [Address, bigint, boolean];
    return c[2];
  }

  async spotHead(pool: bigint): Promise<bigint> {
    if (!this.spot) return 0n;
    const p = (await this.client.readContract({ address: this.spot, abi: this.abi, functionName: "pool", args: [pool] })) as { head: Hex };
    return BigInt(p.head);
  }

  spotPool(id: bigint): SpotPoolInfo | undefined {
    return this.spotPools.find((p) => p.id === id);
  }

  market(id: bigint): MarketInfo | undefined {
    return this.markets.find((m) => m.id === id);
  }

  /** Public keys are read fresh, because a rotation can take effect while a service runs (D-24). */
  async refreshKeys(): Promise<void> {
    if (!this.rotationSupported) return;
    const epoch = await this.readMarkets<bigint>("keyEpoch");
    if (epoch === this.keyEpochSeen) return;
    const [cx, cy, ax, ay, bx, by] = await Promise.all(["coordinatorX", "coordinatorY", "riskAX", "riskAY", "riskBX", "riskBY"].map((name) => this.read<bigint>(name)));
    this.coordinator = { x: cx!, y: cy! };
    this.riskKeys = [{ x: ax!, y: ay! }, { x: bx!, y: by! }];
    this.keyEpochSeen = epoch;
  }

  private readMarkets<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    if (!this.marketsModule) throw new Error("This deployment has no markets module");
    return this.client.readContract({ address: this.marketsModule, abi: this.abi, functionName, args }) as Promise<T>;
  }

  /**
   * A service must hold a key this deployment has used for its slot: the current one, one scheduled next, or one retired. A key the
   * deployment has never had is a configuration mistake and stops the service; a retired key alone still reads and clears old records.
   */
  async assertKeyKnown(ring: KeyRing, slot: KeySlot, name: string): Promise<void> {
    const known: Point[] = [slot === "coordinator" ? this.coordinator : slot === "riskA" ? this.riskKeys[0] : this.riskKeys[1]];
    if (this.rotationSupported) {
      const epoch = await this.readMarkets<bigint>("keyEpoch");
      for (let i = 0n; i <= epoch; i++) known.push((await this.readMarkets<KeySetRead>("keySetAt", [i]))[slot]);
      const [activatesAt, pending] = await this.readMarkets<readonly [bigint, KeySetRead]>("pendingKeyRotation");
      if (activatesAt !== 0n) known.push(pending[slot]);
    }
    if (!known.some((pk) => ring.indexOf(pk) !== -1)) throw new Error(`${name} does not match any key this deployment has used for ${slot}`);
  }

  deploymentView(): Record<string, unknown> {
    return {
      chainId: this.chain.id,
      pool: this.pool,
      asset: this.asset,
      oracle: this.oracle,
      startBlock: this.startBlock,
      deploymentId: this.deploymentId,
      coordinator: this.coordinator,
      riskKeys: this.riskKeys,
      feeTo: this.feeTo,
      exitBond: this.exitBond,
      markets: this.markets.map((m) => m.id),
      spot: this.spot,
      marketsModule: this.marketsModule,
      spotTokens: this.spotTokens,
      spotPools: this.spotPools.map((p) => ({ id: p.id, token0: p.token0, token1: p.token1, feeBps: p.feeBps })),
    };
  }
}

/** A deployment made before key rotation has no such function and never changes keys. An RPC failure is not that, so it propagates. */
async function supportsRotation(client: PublicClient<Transport, Chain>, markets: Address, abi: Abi): Promise<boolean> {
  try {
    await client.readContract({ address: markets, abi, functionName: "keyEpoch" });
    return true;
  } catch (error) {
    if (error instanceof ContractFunctionExecutionError) return false;
    throw error;
  }
}

export function bytesToHex(b: Uint8Array): Hex {
  return `0x${Buffer.from(b).toString("hex")}`;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
