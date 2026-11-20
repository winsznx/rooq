/**
 * Owner-only analytics (ADR-P01, D-06, PRIV-01). Indexes public protocol events into SQLite, reads our own EOAs' balances
 * and every service's /health, and counts cookieless pageviews. It holds no keys and decrypts nothing. The admin routes
 * answer only the web server, behind a bearer token, and return counts, public amounts and operator EOAs: never a list
 * of user addresses, and nothing a service decrypted.
 */
import { readFileSync } from "node:fs";
import { APP_URL, DOCS_URL } from "@rooq/config";
import { getAddress, numberToHex, parseAbi, type Address, type Hex } from "viem";
import { intEnv, PORTS, type Env } from "../lib/config";
import { errorMessage } from "../lib/log";
import { runService, type ServiceContext, type ServiceHandlers } from "../lib/service";
import type { DeploymentFile } from "../lib/chain";
import { takeAdminToken } from "../lib/analytics-auth";
import { FEED_EVENTS, MARKETS_EVENTS, POOL_EVENTS, SPOT_EVENTS } from "../lib/analytics-events";
import { healthTargets, ServiceProbe } from "../lib/analytics-health";
import { AnalyticsIndexer, viemIndexerChain, type LogSource } from "../lib/analytics-indexer";
import { OperatorBook, parseOperators } from "../lib/analytics-operators";
import { AdminReports, type MarketMeta, type PoolMeta } from "../lib/analytics-report";
import { adminRoutes, pageviewRoute } from "../lib/analytics-routes";
import { buildSelectorMap, loadProtocolAbi } from "../lib/analytics-selectors";
import { AnalyticsStore } from "../lib/analytics-store";
import type { PricedFeed } from "../lib/analytics-prices";
import { loadTokenConfig } from "../lib/analytics-token-config";
import { TokenIndexer, tokenClient, viemTokenIndexChain } from "../lib/analytics-token-indexer";
import { fetchEthUsd, TokenSlice, viemTokenLiveChain } from "../lib/analytics-token-report";
import { TokenStore } from "../lib/analytics-token-store";
import { erc20Reader, TokenBook } from "../lib/analytics-tokens";
import { beaconOrigins } from "../lib/analytics-traffic";
import { VaultReader, viemVaultChain } from "../lib/analytics-vault";

const ORACLE_ABI = parseAbi([
  "struct FeedConfig { address aggregator; address asset; uint32 heartbeat; uint8 decimals; bool approved; uint256 minPrice; uint256 maxPrice; }",
  "function feedConfig(bytes32 feedId) view returns (FeedConfig)",
]);

/** Matches the relayer's finality margin: about 12 seconds of 192 ms blocks. */
const DEFAULT_FINALITY_BLOCKS = 64;
const HEALTH_TIMEOUT_MS = 2_500;
const HEALTH_TTL_MS = 5_000;
const VAULT_TTL_MS = 60_000;
/**
 * Part of the source fingerprint. Bumped when the index starts keeping something it didn't before, so existing databases
 * rebuild and backfill it: 2 added the hourly oracle answers that value flows in dollars.
 */
const INDEX_SCHEMA = 2;

/**
 * Feed contracts by feed id: every market's feed plus the deployment's extra feed, which later created markets use.
 * Read once at startup; a feed added afterwards changes the source fingerprint on the next start and the index rebuilds.
 */
interface FeedInfo {
  readonly aggregator: Address;
  /** The Stock Token the feed prices, which names the market. */
  readonly asset: Address;
  /** Decimals of the feed's answer. */
  readonly decimals: number;
}

async function feedAddresses(ctx: ServiceContext): Promise<Map<Hex, FeedInfo>> {
  const { client, oracle, markets } = ctx.chain;
  const deployment = JSON.parse(readFileSync(ctx.config.deploymentFile, "utf8")) as DeploymentFile;
  const feeds = new Map<Hex, FeedInfo>();
  for (const feedId of new Set([...markets.map((m) => m.feedId), ...(deployment.thirdFeedId ? [deployment.thirdFeedId] : [])].map((id) => id.toLowerCase() as Hex))) {
    const cfg = await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "feedConfig", args: [feedId] });
    if (BigInt(cfg.aggregator) !== 0n) feeds.set(feedId, { aggregator: getAddress(cfg.aggregator), asset: getAddress(cfg.asset), decimals: cfg.decimals });
  }
  return feeds;
}

function logSources(ctx: ServiceContext, feeds: readonly Address[]): LogSource[] {
  const { pool, spot, marketsModule } = ctx.chain;
  return [
    ...POOL_EVENTS.map((event) => ({ address: pool, event })),
    ...(spot ? SPOT_EVENTS.map((event) => ({ address: spot, event })) : []),
    ...(marketsModule ? MARKETS_EVENTS.map((event) => ({ address: marketsModule, event })) : []),
    ...[...new Set(feeds)].flatMap((address) => FEED_EVENTS.map((event) => ({ address, event }))),
  ];
}

const tokenAddress = (id: bigint): Address => getAddress(numberToHex(id, { size: 20 }));

async function init(ctx: ServiceContext, env: Env): Promise<ServiceHandlers> {
  const { chain, log } = ctx;
  const dbPath = env.ANALYTICS_DB_PATH ?? "./.data/analytics.db";
  const store = new AnalyticsStore(dbPath);
  const feeds = await feedAddresses(ctx);
  const sources = logSources(ctx, [...feeds.values()].map((f) => f.aggregator));
  const fingerprint = JSON.stringify({ schema: INDEX_SCHEMA, chainId: chain.chain.id, startBlock: chain.startBlock.toString(), sources: sources.map((s) => `${s.address.toLowerCase()}:${s.event}`).sort() });
  if (store.ensureSource(fingerprint)) log.warn("analytics_index_reset", { reason: "SOURCES_CHANGED" });

  const finality = intEnv(env, "FINALITY_BLOCKS", DEFAULT_FINALITY_BLOCKS);
  const indexer = new AnalyticsIndexer(viemIndexerChain(chain.client), store, sources, buildSelectorMap(loadProtocolAbi()), {
    startBlock: chain.startBlock,
    finality: BigInt(finality),
    maxSpan: BigInt(intEnv(env, "ANALYTICS_LOG_RANGE_BLOCKS", 100_000, 1)),
    minSpan: BigInt(intEnv(env, "ANALYTICS_MIN_LOG_RANGE_BLOCKS", 500, 1)),
    reorgDepth: BigInt(intEnv(env, "ANALYTICS_REORG_DEPTH", 1_000, 1)),
    budgetMs: intEnv(env, "ANALYTICS_TICK_BUDGET_MS", 20_000, 1_000),
    intervalMs: intEnv(env, "ANALYTICS_INDEX_INTERVAL_MS", 15_000, 0),
    concurrency: intEnv(env, "ANALYTICS_RPC_CONCURRENCY", 8, 1),
  }, log);

  const operators = new OperatorBook(parseOperators(env.ADMIN_OPERATORS), {
    balance: (address) => chain.client.getBalance({ address }),
    nonce: (address, block) => chain.client.getTransactionCount({ address, blockNumber: block }),
  }, intEnv(env, "ANALYTICS_OPERATOR_REFRESH_MS", 15_000, 1_000), log);
  if (operators.operators.length === 0) log.warn("analytics_no_operators", { reason: "ADMIN_OPERATORS is empty, so our own EOAs count as public wallets" });

  const tokens = new TokenBook(erc20Reader(chain.client), log);
  const tokenAddresses = (): Address[] => [chain.asset, ...chain.spotTokens, ...[...feeds.values()].map((f) => f.asset)];
  await tokens.load(tokenAddresses());
  const symbol = (address: Address): string => tokens.info(address)?.symbol ?? address;
  const markets = (): MarketMeta[] =>
    chain.markets.flatMap((m) => {
      const feed = feeds.get(m.feedId.toLowerCase() as Hex);
      return feed ? [{ id: Number(m.id), symbol: symbol(feed.asset), feed: feed.aggregator }] : [];
    });
  const pools = (): PoolMeta[] => chain.spotPools.map((p) => ({ id: Number(p.id), symbol: `${symbol(tokenAddress(p.token0))}/${symbol(tokenAddress(p.token1))}` }));

  const pricedFeeds = (): PricedFeed[] => [...feeds.values()].map((f) => ({ asset: f.asset, feed: f.aggregator, decimals: f.decimals }));
  const vault = new VaultReader(viemVaultChain(chain.client), chain.pool, chain.asset, tokenAddresses, pricedFeeds, tokens, VAULT_TTL_MS, log);
  const token = openTokenSlice(env, dbPath, ctx);

  const reports = new AdminReports({
    store, indexer, operators, tokens, markets, pools, vault, token,
    stableAsset: chain.asset,
    feeds: pricedFeeds,
    services: new ServiceProbe(healthTargets(env), HEALTH_TIMEOUT_MS, HEALTH_TTL_MS),
    async lastPriceAt(m) {
      const market = chain.market(BigInt(m.id));
      if (!market) return null;
      try {
        return Number((await chain.price(market)).updatedAt);
      } catch (error) {
        log.warn("price_read_failed", { market: m.id, message: errorMessage(error) });
        return null;
      }
    },
  });

  const admin = takeAdminToken(env);
  if (!admin.ok) {
    ctx.liveness.blocked = admin.reason;
    log.warn("admin_routes_disabled", { reason: admin.reason });
  }
  const origins = beaconOrigins(ctx.config.allowedOrigins, [APP_URL, DOCS_URL, ...(env.ANALYTICS_PV_ORIGINS ?? "").split(",")]);
  const routes = [pageviewRoute(store, origins, () => ctx.bump("pageviews")), ...(admin.ok ? adminRoutes(reports, admin.token) : [])];
  ctx.liveness.details = { adminEnabled: admin.ok, operators: operators.operators.length, feeds: feeds.size, tokenSlice: token !== null };

  return {
    routes,
    progress: () => indexer.progress(),
    async tick() {
      try {
        await indexer.tick();
        await chain.syncCreatedMarkets(store.createdMarketIds().map(BigInt));
        const indexed = indexer.state();
        await operators.refresh(indexed.backfilling ? null : BigInt(indexed.indexedBlock));
        await tokens.load([...tokenAddresses(), ...store.flowAssets()]);
        ctx.liveness.backlog = { blocksBehind: Math.max(0, indexer.state().lagBlocks - finality) };
        ctx.liveness.counters.reorgs = indexer.reorgs;
      } finally {
        if (token) await tickToken(token, ctx);
      }
    },
    async shutdown() {
      store.close();
      token?.close();
    },
  };
}

/** The $ROOQ mainnet slice, or null when ROOQ_TOKEN_RPC_URL is unset. */
function openTokenSlice(env: Env, analyticsDbPath: string, ctx: ServiceContext): TokenSlice | null {
  const config = loadTokenConfig(env, analyticsDbPath);
  if (!config) {
    ctx.log.info("token_slice_disabled", { reason: "ROOQ_TOKEN_RPC_URL is unset" });
    return null;
  }
  const store = new TokenStore(config.dbPath);
  const fingerprint = JSON.stringify({ token: config.token.toLowerCase(), poolManager: config.poolManager.toLowerCase(), poolId: config.poolId, startBlock: config.startBlock.toString() });
  if (store.ensureSource(fingerprint)) ctx.log.warn("token_index_reset", { reason: "SOURCES_CHANGED" });
  const client = tokenClient(config);
  const indexer = new TokenIndexer(viemTokenIndexChain(client), store, {
    token: config.token, poolManager: config.poolManager, poolId: config.poolId, startBlock: config.startBlock, finality: config.finality,
    maxSpan: config.maxSpan, minSpan: config.minSpan, budgetMs: config.budgetMs, intervalMs: config.intervalMs, concurrency: config.concurrency,
  }, ctx.log);
  return new TokenSlice(config, indexer, store, viemTokenLiveChain(client, config), () => fetchEthUsd(config.priceUrl), ctx.log);
}

/** Mainnet trouble must not mark the testnet index degraded, so a failed token tick is logged and counted, not thrown. */
async function tickToken(token: TokenSlice, ctx: ServiceContext): Promise<void> {
  try {
    await token.tick();
    ctx.liveness.details.tokenIndexer = token.indexer.state();
  } catch (error) {
    ctx.bump("tokenTickFailures");
    ctx.log.warn("token_tick_failed", { message: errorMessage(error) });
  }
}

await runService({
  name: "analytics",
  port: intEnv(process.env, "PORT", PORTS.analytics, 1),
  ledger: false,
  init: (ctx) => init(ctx, process.env),
});
