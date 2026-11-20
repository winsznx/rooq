import type { AdminVault } from "@rooq/private-sdk/admin";
import { erc20Abi, getAddress, parseAbi, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { errorMessage, type Logger } from "./log";
import { cents, ONE_DOLLAR, usdValue, type Price, type PricedFeed } from "./analytics-prices";
import type { TokenBook } from "./analytics-tokens";

/** The live reads behind the vault slice. */
export interface VaultChain {
  balanceOf(token: Address, holder: Address): Promise<bigint>;
  latestAnswer(feed: Address): Promise<bigint>;
}

const AGGREGATOR_ABI = parseAbi(["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"]);

export function viemVaultChain(client: PublicClient<Transport, Chain>): VaultChain {
  return {
    balanceOf: (token, holder) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
    async latestAnswer(feed) {
      const [, answer] = await client.readContract({ address: feed, abi: AGGREGATOR_ABI, functionName: "latestRoundData" });
      return answer;
    },
  };
}

export interface Holding {
  readonly asset: Address;
  readonly amount: bigint;
  /** Null until the token's decimals have been read. */
  readonly decimals: number | null;
  readonly symbol: string | null;
  readonly price: Price | null;
}

/** Values each holding and its share of the priced total. An unpriced holding has a null value and a zero share. */
export function vaultReport(asOf: number, holdings: readonly Holding[]): AdminVault {
  const valued = holdings.map((h) => ({ h, usd: h.decimals === null || h.price === null ? null : usdValue(h.amount, h.decimals, h.price) }));
  const totalUsd = valued.reduce((sum, v) => sum + (v.usd ?? 0), 0);
  return {
    asOf,
    totalUsd: cents(totalUsd),
    assets: valued
      .map(({ h, usd }) => ({
        asset: h.asset,
        symbol: h.symbol ?? h.asset,
        decimals: h.decimals ?? 0,
        decimalsKnown: h.decimals !== null,
        amount: h.amount.toString(),
        usd: usd === null ? null : cents(usd),
        sharePct: usd === null || totalUsd <= 0 ? 0 : Math.round((usd / totalUsd) * 10_000) / 100,
      }))
      .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || a.symbol.localeCompare(b.symbol)),
  };
}

/**
 * Public balances of the custody contract, which holds every shielded token (the spot and markets modules move no
 * tokens of their own; bonds are paid into custody too). Read at most once per `ttlMs`; concurrent callers share a read.
 */
export class VaultReader {
  private last: { at: number; result: AdminVault } | null = null;
  private inFlight: Promise<AdminVault> | null = null;

  constructor(
    private readonly chain: VaultChain,
    private readonly custody: Address,
    private readonly stable: Address,
    private readonly assets: () => readonly Address[],
    private readonly feeds: () => readonly PricedFeed[],
    private readonly tokens: TokenBook,
    private readonly ttlMs: number,
    private readonly log: Logger,
  ) {}

  snapshot(now = Date.now()): Promise<AdminVault> {
    if (this.last && now - this.last.at < this.ttlMs) return Promise.resolve(this.last.result);
    this.inFlight ??= this.read()
      .then((result) => {
        this.last = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async read(): Promise<AdminVault> {
    const assets = [...new Set(this.assets().map((a) => getAddress(a)))];
    const feeds = this.feeds();
    const holdings = await Promise.all(assets.map(async (asset): Promise<Holding> => {
      const info = this.tokens.info(asset);
      const [amount, price] = await Promise.all([this.chain.balanceOf(asset, this.custody), this.priceOf(asset, feeds)]);
      return { asset, amount, decimals: info?.decimals ?? null, symbol: info?.symbol ?? null, price };
    }));
    return vaultReport(Math.floor(Date.now() / 1000), holdings);
  }

  /** A failed price read leaves that asset unpriced; a failed balance read fails the snapshot, since the total would be wrong. */
  private async priceOf(asset: Address, feeds: readonly PricedFeed[]): Promise<Price | null> {
    if (asset.toLowerCase() === this.stable.toLowerCase()) return ONE_DOLLAR;
    const feed = feeds.find((f) => f.asset.toLowerCase() === asset.toLowerCase());
    if (!feed) return null;
    try {
      return { answer: await this.chain.latestAnswer(getAddress(feed.feed)), decimals: feed.decimals };
    } catch (error) {
      this.log.warn("vault_price_failed", { asset, message: errorMessage(error) });
      return null;
    }
  }
}
