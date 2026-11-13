import { erc20Abi, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import type { ChainContext } from "./chain";
import type { Logger } from "./log";

const ORACLE_ABI = parseAbi(["function feedConfig(bytes32 feedId) view returns (address aggregator)"]);
const FEED_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const ANSWER_EVENT = parseAbiItem("event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)");
/** About a day of blocks on Robinhood Chain: enough for every chart range the app draws. */
const PRICE_LOOKBACK_BLOCKS = 600_000n;
const PRICE_POINTS_KEPT = 2_000;
const LOG_SPAN = 500_000n;
const MIN_LOG_SPAN = 2_000n;

export interface TokenMeta {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

export interface PricePoint {
  readonly time: number;
  readonly price: number;
}

interface FeedState {
  readonly market: bigint;
  readonly feed: Address;
  readonly decimals: number;
  from: bigint;
  points: PricePoint[];
}

/**
 * Public data every visitor needs before they can see a market: token details, the chain head and its time, and recent
 * oracle prices. One copy here, read from chain once, so a browser makes one request instead of dozens of RPC reads.
 */
export class PublicIndex {
  tokens: TokenMeta[] = [];
  headTime: bigint | null = null;
  private feeds = new Map<bigint, FeedState>();

  constructor(
    private readonly chain: ChainContext,
    private readonly log: Logger,
  ) {}

  prices(market: bigint, since: number): PricePoint[] {
    const state = this.feeds.get(market);
    return state ? state.points.filter((p) => p.time > since) : [];
  }

  async refresh(head: bigint): Promise<void> {
    if (head === 0n) return;
    const { client } = this.chain;
    if (this.tokens.length === 0) await this.loadTokens();
    this.headTime = (await client.getBlock({ blockNumber: head })).timestamp;
    for (const m of this.chain.markets) {
      try {
        await this.refreshFeed(m.id, m.feedId, head);
      } catch (error) {
        this.log.warn("price_history_failed", { market: m.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async loadTokens(): Promise<void> {
    const { client } = this.chain;
    const addresses = [this.chain.asset, ...this.chain.spotTokens];
    this.tokens = await Promise.all(addresses.map(async (address) => {
      const [symbol, name, decimals] = await Promise.all([
        client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address, abi: erc20Abi, functionName: "name" }),
        client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      ]);
      return { address, symbol, name, decimals };
    }));
  }

  private async refreshFeed(market: bigint, feedId: Hex, head: bigint): Promise<void> {
    const { client } = this.chain;
    let state = this.feeds.get(market);
    if (!state) {
      const feed = await client.readContract({ address: this.chain.oracle, abi: ORACLE_ABI, functionName: "feedConfig", args: [feedId] });
      const decimals = await client.readContract({ address: feed, abi: FEED_ABI, functionName: "decimals" });
      const recent = head > PRICE_LOOKBACK_BLOCKS ? head - PRICE_LOOKBACK_BLOCKS : 0n;
      state = { market, feed, decimals, from: this.chain.startBlock > recent ? this.chain.startBlock : recent, points: [] };
      this.feeds.set(market, state);
    }
    let span = LOG_SPAN;
    while (state.from <= head) {
      const to = state.from + span - 1n > head ? head : state.from + span - 1n;
      let logs;
      try {
        logs = await client.getLogs({ address: state.feed, event: ANSWER_EVENT, fromBlock: state.from, toBlock: to });
      } catch (error) {
        if (span <= MIN_LOG_SPAN) throw error;
        span /= 2n;
        continue;
      }
      for (const l of logs) state.points.push({ time: Number(l.args.updatedAt), price: Number(l.args.current) / 10 ** state.decimals });
      state.from = to + 1n;
    }
    if (state.points.length > PRICE_POINTS_KEPT) state.points.splice(0, state.points.length - PRICE_POINTS_KEPT);
  }
}
