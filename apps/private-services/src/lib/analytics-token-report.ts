import type { AdminToken, SeriesPoint } from "@rooq/private-sdk/admin";
import { encodeAbiParameters, erc20Abi, hexToBigInt, keccak256, parseAbi, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { cents } from "./analytics-prices";
import { bucketStart, denseSeries, firstPoint, type Window } from "./analytics-series";
import { TOKEN_USER_AGENT, type TokenConfig } from "./analytics-token-config";
import type { TokenIndexer } from "./analytics-token-indexer";
import type { StoredSwap, TokenStore } from "./analytics-token-store";
import { errorMessage, type Logger } from "./log";

const Q96 = 2n ** 96n;
const UINT160_MASK = (1n << 160n) - 1n;
const WEI = 1e18;
/** Slot of `pools` in the v4 PoolManager; a pool's state starts at keccak(poolId, 6), with liquidity three slots in. */
const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3;
/** A failed ETH/USD fetch keeps the last good quote this long before the page shows none. */
const ETH_USD_GRACE_MS = 15 * 60_000;

export const BURN_ADDRESSES: readonly string[] = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"];

const POOL_MANAGER_ABI = parseAbi(["function extsload(bytes32 startSlot, uint256 nSlots) view returns (bytes32[])"]);
const FEE_ESCROW_ABI = parseAbi(["function balanceOf(address recipient) view returns (uint256)", "function balanceOfToken(address recipient, address token) view returns (uint256)"]);

export interface PoolState {
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
}

/** The live mainnet reads behind the token slice. */
export interface TokenLiveChain {
  poolState(): Promise<PoolState>;
  totalSupply(): Promise<bigint>;
  escrowEth(): Promise<bigint>;
  escrowRooq(): Promise<bigint>;
}

export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, POOLS_SLOT]));
}

export function viemTokenLiveChain(client: PublicClient<Transport, Chain>, config: TokenConfig): TokenLiveChain {
  return {
    async poolState() {
      const words = await client.readContract({ address: config.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [poolStateSlot(config.poolId), BigInt(LIQUIDITY_OFFSET + 1)] });
      const slot0 = words[0];
      const liquidity = words[LIQUIDITY_OFFSET];
      if (slot0 === undefined || liquidity === undefined) throw new Error("extsload returned too few slots");
      return { sqrtPriceX96: hexToBigInt(slot0) & UINT160_MASK, liquidity: hexToBigInt(liquidity) };
    },
    totalSupply: () => client.readContract({ address: config.token, abi: erc20Abi, functionName: "totalSupply" }),
    escrowEth: () => client.readContract({ address: config.feeEscrow, abi: FEE_ESCROW_ABI, functionName: "balanceOf", args: [config.creator] }),
    escrowRooq: () => client.readContract({ address: config.feeEscrow, abi: FEE_ESCROW_ABI, functionName: "balanceOfToken", args: [config.creator, config.token] }),
  };
}

/** ETH per ROOQ. currency0 is native ETH and both sides have 18 decimals, so sqrtPriceX96² / 2^192 is ROOQ per ETH. */
export function priceEthOf(sqrtPriceX96: bigint): number | null {
  if (sqrtPriceX96 <= 0n) return null;
  const root = Number(sqrtPriceX96) / Number(Q96);
  return 1 / (root * root);
}

/** ETH on the pool's virtual curve at the current price: L / sqrtP. Exact for full-range liquidity. */
export function poolEthOf(state: PoolState): number | null {
  if (state.sqrtPriceX96 <= 0n) return null;
  return Number((state.liquidity * Q96) / state.sqrtPriceX96) / WEI;
}

/** In v4 the swap delta is the swapper's: paying ETH in (amount0 < 0) is a buy, and moves the price of ROOQ up. */
export const isBuy = (swap: StoredSwap): boolean => swap.amount0 < 0n;

const ethOf = (swap: StoredSwap): number => Number(swap.amount0 < 0n ? -swap.amount0 : swap.amount0) / WEI;

export interface SwapWindow {
  readonly volumeEth: number;
  readonly buys: number;
  readonly sells: number;
  readonly buyEth: number;
  readonly sellEth: number;
}

export function swapWindow(swaps: readonly StoredSwap[]): SwapWindow {
  let buys = 0;
  let buyEth = 0;
  let sellEth = 0;
  for (const s of swaps) {
    if (isBuy(s)) {
      buys++;
      buyEth += ethOf(s);
    } else {
      sellEth += ethOf(s);
    }
  }
  return { volumeEth: buyEth + sellEth, buys, sells: swaps.length - buys, buyEth, sellEth };
}

/**
 * Price per bucket, the last swap's price in it, carried forward through quiet buckets from the price the window opened
 * at. Buckets before the first known price are 0.
 */
export function priceSeries(swaps: readonly StoredSwap[], opening: StoredSwap | null, w: Window, start: number | undefined, toUsd: number): SeriesPoint[] {
  const last = new Map<number, number>();
  for (const s of swaps) {
    const price = priceEthOf(s.sqrtPriceX96);
    if (price !== null) last.set(bucketStart(s.time, w.bucket), price * toUsd);
  }
  const openingPrice = opening ? priceEthOf(opening.sqrtPriceX96) : null;
  let carried = openingPrice === null ? 0 : openingPrice * toUsd;
  return denseSeries([], w, start).map((p) => {
    carried = last.get(p.t) ?? carried;
    return { t: p.t, v: carried };
  });
}

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/**
 * ETH/USD from either a CoinGecko simple-price body (`{ ethereum: { usd } }`) or a Pons launch JSON (`quoteUsd`).
 * Throws when neither shape carries a positive number.
 */
export async function fetchEthUsd(url: string, fetcher: Fetcher = fetch): Promise<number> {
  const res = await fetcher(url, { headers: { "user-agent": TOKEN_USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const quote = ethUsdFrom(await res.json());
  if (quote === null) throw new Error("ETH/USD is missing or not a positive number");
  return quote;
}

function ethUsdFrom(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const pons = "quoteUsd" in body ? body.quoteUsd : undefined;
  const gecko = "ethereum" in body && typeof body.ethereum === "object" && body.ethereum !== null && "usd" in body.ethereum ? body.ethereum.usd : undefined;
  const quote = pons ?? gecko;
  return typeof quote === "number" && Number.isFinite(quote) && quote > 0 ? quote : null;
}

interface Live {
  readonly pool: PoolState | null;
  readonly totalSupply: bigint | null;
  readonly escrowEth: bigint | null;
  readonly escrowRooq: bigint | null;
  readonly ethUsd: number | null;
}

/** The $ROOQ slice: its own index, live pool and escrow reads, and ETH/USD, each part degrading to null on its own. */
export class TokenSlice {
  private live: { at: number; value: Live } | null = null;
  private inFlight: Promise<Live> | null = null;
  private ethUsd: { at: number; value: number } | null = null;

  constructor(
    private readonly config: TokenConfig,
    readonly indexer: TokenIndexer,
    private readonly store: TokenStore,
    private readonly chain: TokenLiveChain,
    private readonly ethUsdSource: () => Promise<number>,
    private readonly log: Logger,
  ) {}

  tick(): Promise<void> {
    return this.indexer.tick();
  }

  close(): void {
    this.store.close();
  }

  private async attempt<T>(what: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      this.log.warn("token_read_failed", { what, message: errorMessage(error) });
      return null;
    }
  }

  private async readEthUsd(): Promise<number | null> {
    const fresh = await this.attempt("eth_usd", this.ethUsdSource);
    if (fresh !== null) this.ethUsd = { at: Date.now(), value: fresh };
    return this.ethUsd && Date.now() - this.ethUsd.at < ETH_USD_GRACE_MS ? this.ethUsd.value : null;
  }

  private liveReads(now = Date.now()): Promise<Live> {
    if (this.live && now - this.live.at < this.config.liveTtlMs) return Promise.resolve(this.live.value);
    this.inFlight ??= Promise.all([
      this.attempt("pool_state", () => this.chain.poolState()),
      this.attempt("total_supply", () => this.chain.totalSupply()),
      this.attempt("escrow_eth", () => this.chain.escrowEth()),
      this.attempt("escrow_rooq", () => this.chain.escrowRooq()),
      this.readEthUsd(),
    ])
      .then(([pool, totalSupply, escrowEth, escrowRooq, ethUsd]) => {
        const value = { pool, totalSupply, escrowEth, escrowRooq, ethUsd };
        this.live = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * Dollar figures use the current ETH/USD for every swap, the only quote there is; with no quote they are 0 and
   * `ethUsd` is null. Holders are null until the index has reached the head once, since a partial count would mislead.
   */
  async report(w: Window): Promise<AdminToken> {
    const live = await this.liveReads();
    const swaps = this.store.swapsSince(w.since);
    const lastSwap = swaps.at(-1) ?? this.store.lastSwapBefore(w.now + 1);
    const priceEth = live.pool ? priceEthOf(live.pool.sqrtPriceX96) : lastSwap ? priceEthOf(lastSwap.sqrtPriceX96) : null;
    const ethUsd = live.ethUsd;
    const toUsd = ethUsd ?? 0;
    const priceUsd = priceEth !== null && ethUsd !== null ? priceEth * ethUsd : null;
    const window = swapWindow(swaps);
    const lifetime = w.since === 0 ? window : swapWindow(this.store.swapsSince(0));
    const start = firstPoint(swaps.map((s) => ({ t: s.time, n: 1 })));
    const series = (pick: (s: StoredSwap) => number): SeriesPoint[] => denseSeries(swaps.map((s) => ({ t: s.time, n: pick(s) })), w, start);
    return {
      asOf: Math.floor(Date.now() / 1000),
      token: this.config.token,
      priceUsd,
      priceEth,
      marketCapUsd: priceUsd !== null && live.totalSupply !== null ? cents(priceUsd * (Number(live.totalSupply) / WEI)) : null,
      ethUsd,
      poolEth: live.pool ? poolEthOf(live.pool) : null,
      window: {
        range: w.range,
        volumeUsd: cents(window.volumeEth * toUsd),
        buys: window.buys,
        sells: window.sells,
        buyUsd: cents(window.buyEth * toUsd),
        sellUsd: cents(window.sellEth * toUsd),
        uniqueTraders: this.store.uniqueTraders(w.since),
      },
      holders: this.indexer.caughtUp ? this.store.holders([...BURN_ADDRESSES, this.config.poolManager]) : null,
      creatorFees: {
        pendingEth: live.escrowEth === null ? null : Number(live.escrowEth) / WEI,
        pendingRooq: live.escrowRooq === null ? null : Number(live.escrowRooq) / WEI,
        estimatedLifetimeUsd: ethUsd === null ? null : cents((lifetime.volumeEth * ethUsd * this.config.creatorRateBps) / 10_000),
        rateBps: this.config.creatorRateBps,
      },
      series: {
        price: priceSeries(swaps, this.store.lastSwapBefore(w.since), w, start, toUsd),
        volume: series((s) => ethOf(s) * toUsd).map((p) => ({ t: p.t, v: cents(p.v) })),
        buys: series((s) => (isBuy(s) ? 1 : 0)),
        sells: series((s) => (isBuy(s) ? 0 : 1)),
      },
      indexer: this.indexer.state(),
    };
  }
}

