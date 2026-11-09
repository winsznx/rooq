/**
 * TEST oracle relay for the private markets. Copies Robinhood's public reference price into each market's MockPriceFeed.
 * It's one operator with one key, not an independent oracle, which is what the app's "TEST price relay, single operator"
 * label says. Feeds, tokens and tickers all come from the chain and the verified asset registry, never from a symbol
 * in a config file.
 *
 * Fail-closed: when the source is halted, unreachable or old, nothing is written and the contracts block new risk once
 * the feed passes its heartbeat. Only feeds this key operates and whose token is a verified Stock Token are relayed.
 */
import { readFileSync } from "node:fs";
import { ReferencePriceSource, TESTNET_STOCK_TOKENS, TEST_RELAY_OPERATOR, TEST_RELAY_SOURCE } from "@rooq/config";
import { createWalletClient, http, parseAbi, type Account, type Address, type Chain, type Hex, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { intEnv, PORTS, takePrivateKey } from "../lib/config";
import { errorMessage } from "../lib/log";
import { runService, type ServiceContext } from "../lib/service";
import type { DeploymentFile } from "../lib/chain";

const ORACLE_ABI = parseAbi([
  "struct FeedConfig { address aggregator; address asset; uint32 heartbeat; uint8 decimals; bool approved; uint256 minPrice; uint256 maxPrice; }",
  "function feedConfig(bytes32 feedId) view returns (FeedConfig)",
  "function getPrice(bytes32 feedId) view returns (uint256 priceWad, uint256 updatedAt, bool fresh)",
]);
const FEED_ABI = parseAbi([
  "function operator() view returns (address)",
  "function setAnswer(int256 answer)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

interface RelayedFeed {
  readonly feedId: Hex;
  readonly aggregator: Address;
  readonly symbol: string;
  readonly market: bigint | null;
}

interface FeedStatus {
  readonly symbol: string;
  readonly market: bigint | null;
  answer8: bigint;
  ageSeconds: number;
  fresh: boolean;
  lastSkip: string | null;
}

class PriceRelay {
  private readonly source: ReferencePriceSource;
  private readonly wallet: WalletClient<Transport, Chain, Account>;
  private readonly feeds = new Map<Hex, RelayedFeed>();
  private readonly status = new Map<Hex, FeedStatus>();
  private readonly skipped = new Set<Hex>();
  private readonly intervalMs = intEnv(process.env, "RELAY_INTERVAL_MS", 30_000, 1_000);
  private readonly minChangeBps = BigInt(intEnv(process.env, "RELAY_MIN_CHANGE_BPS", 5, 1));
  private readonly refreshSeconds = BigInt(intEnv(process.env, "RELAY_REFRESH_SECONDS", 900, 1));
  private readonly deployedFeeds: readonly Hex[];
  private nextRunAt = 0;

  constructor(private readonly ctx: ServiceContext, privateKey: Hex) {
    this.source = new ReferencePriceSource(intEnv(process.env, "MAX_SOURCE_AGE_SECONDS", 120, 1), intEnv(process.env, "RELAY_MULTIPLIER_TTL_MS", 300_000, 1_000));
    this.wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: ctx.chain.chain, transport: http(ctx.config.rpcUrl, { timeout: 15_000 }) });
    const deployment = JSON.parse(readFileSync(ctx.config.deploymentFile, "utf8")) as DeploymentFile;
    this.deployedFeeds = deployment.thirdFeedId ? [deployment.thirdFeedId] : [];
    ctx.liveness.details = { source: TEST_RELAY_SOURCE, label: TEST_RELAY_OPERATOR, intervalMs: this.intervalMs };
  }

  private async track(feedId: Hex, market: bigint | null): Promise<void> {
    if (this.feeds.has(feedId) || this.skipped.has(feedId)) return;
    const { client, oracle } = this.ctx.chain;
    const cfg = await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "feedConfig", args: [feedId] });
    const token = TESTNET_STOCK_TOKENS.find((a) => a.address.toLowerCase() === cfg.asset.toLowerCase());
    const operator = cfg.aggregator === "0x0000000000000000000000000000000000000000" ? null : await client.readContract({ address: cfg.aggregator, abi: FEED_ABI, functionName: "operator" });
    if (!token || operator !== this.wallet.account.address) {
      this.skipped.add(feedId);
      this.ctx.log.warn("feed_skipped", { feedId, market, reason: token ? "NOT_OPERATOR" : "NOT_A_VERIFIED_STOCK_TOKEN" });
      return;
    }
    this.feeds.set(feedId, { feedId, aggregator: cfg.aggregator, symbol: token.symbol, market });
    this.ctx.log.info("feed_tracked", { feedId, market, symbol: token.symbol });
  }

  private async discover(): Promise<void> {
    for (const m of this.ctx.chain.markets) await this.track(m.feedId, m.id);
    for (const feedId of this.deployedFeeds) await this.track(feedId, null);
    if (this.feeds.size === 0) throw new Error("No feed on this deployment is operated by PRICE_RELAY_TX_KEY");
  }

  private async relay(feed: RelayedFeed, now: bigint): Promise<string | null> {
    const q = await this.source.quote(feed.symbol);
    if (q.status !== "ok") {
      this.ctx.bump(`skip_${q.status}`);
      return q.status;
    }
    const { client } = this.ctx.chain;
    const [, answer, , updatedAt] = await client.readContract({ address: feed.aggregator, abi: FEED_ABI, functionName: "latestRoundData" });
    const delta = q.answer8 > answer ? q.answer8 - answer : answer - q.answer8;
    if (delta * 10_000n < answer * this.minChangeBps && now - updatedAt < this.refreshSeconds) return null;
    const hash = await this.wallet.writeContract({ address: feed.aggregator, abi: FEED_ABI, functionName: "setAnswer", args: [q.answer8] });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status !== "success") throw new Error(`setAnswer reverted for ${feed.symbol}`);
    this.ctx.bump("prices_written");
    this.ctx.recordAction("price_written", hash);
    this.ctx.log.info("price_written", { symbol: feed.symbol, answer8: q.answer8, bid: q.bid, ask: q.ask, multiplier: q.multiplier, sourceAt: q.sourceAt, tx: hash });
    return null;
  }

  private async report(feed: RelayedFeed, now: bigint, lastSkip: string | null): Promise<void> {
    const { client, oracle } = this.ctx.chain;
    const [priceWad, updatedAt, fresh] = await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "getPrice", args: [feed.feedId] });
    this.status.set(feed.feedId, { symbol: feed.symbol, market: feed.market, answer8: priceWad / 10n ** 10n, ageSeconds: Math.max(0, Number(now - updatedAt)), fresh, lastSkip });
  }

  async tick(): Promise<void> {
    if (Date.now() < this.nextRunAt) return;
    this.nextRunAt = Date.now() + this.intervalMs;
    await this.discover();
    await this.source.refreshMultipliers();
    const now = await this.ctx.chain.blockTime();
    let failed = 0;
    for (const feed of this.feeds.values()) {
      let skip: string | null = "RELAY_ERROR";
      try {
        skip = await this.relay(feed, now);
      } catch (error) {
        failed++;
        this.ctx.bump("relay_errors");
        this.ctx.log.warn("relay_failed", { symbol: feed.symbol, message: errorMessage(error) });
      }
      await this.report(feed, now, skip);
    }
    const stale = [...this.status.values()].filter((s) => !s.fresh).map((s) => s.symbol);
    this.ctx.liveness.blocked = stale.length > 0 ? `FEED_STALE:${stale.join(",")}` : failed > 0 ? "RELAY_ERRORS" : null;
    this.ctx.liveness.backlog = { feedsStale: stale.length };
    const balanceWei = await this.ctx.chain.client.getBalance({ address: this.wallet.account.address });
    this.ctx.liveness.details = { ...this.ctx.liveness.details, operator: this.wallet.account.address, gasBalanceWei: balanceWei, feeds: [...this.status.values()] };
  }
}

await runService({
  name: "price-relay",
  port: intEnv(process.env, "PORT", PORTS.priceRelay, 1),
  init(ctx) {
    const relay = new PriceRelay(ctx, takePrivateKey(process.env, "PRICE_RELAY_TX_KEY"));
    return { tick: () => relay.tick() };
  },
});
