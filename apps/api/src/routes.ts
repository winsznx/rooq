import type { Server } from "bun";
import { getAddress, zeroAddress, type Hex } from "viem";
import { explorerTxUrl, type Deployment } from "@rooq/config";
import {
  PERP_STATUS,
  PREFLIGHT_CHECKS,
  PREFLIGHT_VERDICT,
  SPOT_STATUS,
  marginVaultAbi,
  marketPreflightAbi,
  minReceived,
  spotFactoryAbi,
  spotRouterAbi,
  type AccountResponse,
  type ActivityResponse,
  type ChartResponse,
  type FeesResponse,
  type FinalityTier,
  type HealthResponse,
  type IndexerHealth,
  type MarketStatusDetail,
  type MarketSummary,
  type MarketsResponse,
  type PreflightResponse,
  type SpotQuoteResponse,
  type StatusResponse,
  type TradeRow,
  type TradesResponse,
  type TransactionResponse,
} from "@rooq/sdk";
import { activityRow } from "./activity";
import { parseInterval, toCandles } from "./candles";
import { anchorBlock, requireDeployment, type Anchored, type ChainHandle } from "./chain";
import type { ApiConfig } from "./config";
import { decodeCursor, encodeCursor } from "./cursor";
import { history, optionalHistory, type Db } from "./db";
import { ApiError, badRequest, notFound, networkDelayed } from "./errors";
import {
  activityPage,
  indexerHealth,
  lastReconciliation,
  lastReorg,
  lastStatusChanges,
  oracleCandles,
  takerMarkets,
  tokenMeta,
  tradeCandles,
  tradesPage,
  txSightings,
  windowStats,
  type WindowStats,
} from "./history";
import { json, parseAddress, parseBytes32, parseLimit, parseSmallInt, parseUint, readBodyText, readJsonObject, type RateLimiter } from "./http";
import { logError } from "./log";
import {
  listMarketIds,
  positionView,
  readBalances,
  readCollateral,
  readLp,
  readMarketStructs,
  readMarkets,
  readOracle,
  readPool,
  readPositions,
  type MarketRead,
  type TokenCache,
} from "./reads";
import { openStream, parseLastEventId } from "./stream";
import { assetView, change24hWad, effectiveStatus, hopFees, oracleView, perpStatusName, perpView, routePriceImpactBps, spotStatusName, spotView, type Hop } from "./views";

export interface Services {
  readonly cfg: ApiConfig;
  readonly chain: ChainHandle;
  readonly sql: Db;
  readonly tokens: TokenCache;
  readonly limiter: RateLimiter;
  readonly version: string;
}

export interface RequestContext {
  readonly req: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly cors: Record<string, string>;
  readonly ip: string;
  readonly server: Server<undefined>;
  readonly svc: Services;
}

type Handler = (ctx: RequestContext) => Promise<Response>;

const FEES_DOMAIN: Hex = "0xd4ef6c38af683a39d57f487a3dd5121162cde244b89a436bdf30b8767d1ec5e1";
const DAY = 86_400n;

function param(ctx: RequestContext, key: string): string {
  const value = ctx.params[key];
  if (value === undefined) throw new Error(`route parameter ${key} missing`);
  return value;
}

function limits(cfg: ApiConfig) {
  return { staleSeconds: cfg.indexerStaleSeconds, maxLagBlocks: cfg.indexerMaxLagBlocks };
}

function finality(cfg: ApiConfig): FinalityTier {
  return cfg.env === "testnet" ? "sequencer" : "local";
}

async function headOrNull(svc: Services): Promise<bigint | null> {
  try {
    await svc.chain.verified();
    return await svc.chain.client.getBlockNumber({ cacheTime: 0 });
  } catch (error) {
    logError("rpc_head_unavailable", error);
    return null;
  }
}

function indexerFor(svc: Services, head: bigint | null): Promise<IndexerHealth> {
  return indexerHealth(svc.sql, svc.chain.config.chainId, head, limits(svc.cfg));
}

function rateLimit(ctx: RequestContext): void {
  if (!ctx.svc.limiter.allow(ctx.ip)) throw new ApiError(429, "RATE_LIMITED", "Too many requests. Wait a moment and try again.", true);
}

// ------------------------------------------------------------------ markets

function marketKey(dep: Deployment, read: MarketRead): string {
  return dep.markets.find((m) => m.marketId.toLowerCase() === read.market.id.toLowerCase())?.key ?? read.base.symbol;
}

function summary(svc: Services, dep: Deployment, read: MarketRead, anchored: Anchored, stats: Map<string, WindowStats> | null): MarketSummary {
  const chainId = svc.chain.config.chainId;
  const oracle = read.oracle ? oracleView(read.oracle, anchored.timestamp, dep) : null;
  const id = read.market.id.toLowerCase();
  const pool = stats?.get(`${id}:swap`) ?? null;
  const perp = stats?.get(`${id}:perp`) ?? null;
  return {
    marketId: read.market.id,
    key: marketKey(dep, read),
    base: assetView(read.base, chainId, dep),
    quote: assetView(read.quote, chainId, dep),
    creator: getAddress(read.market.creator),
    createdAt: Number(read.market.createdAt),
    spot: spotView(read.pool, read.market.spotStatus, read.base, read.quote),
    perp: perpView(read.perp, oracle),
    change24hWad: pool ? (change24hWad(pool.refPrice, pool.firstPrice, pool.lastPrice)?.toString() ?? null) : null,
    volume24hQuote: pool?.volumeQuote?.toString() ?? null,
    perpChange24hWad: perp ? (change24hWad(perp.refPrice, perp.firstPrice, perp.lastPrice)?.toString() ?? null) : null,
    perpVolume24hQuote: perp?.volumeQuote?.toString() ?? null,
    anchor: anchored.anchor,
  };
}

async function stats24h(svc: Services, ids: readonly Hex[], anchored: Anchored): Promise<Map<string, WindowStats> | null> {
  return optionalHistory(svc.sql, (q) => windowStats(q, svc.chain.config.chainId, ids, anchored.timestamp - DAY, anchored.timestamp));
}

const KINDS = ["spot", "perp", "both"] as const;
const STATUSES: ReadonlySet<string> = new Set<string>([...PERP_STATUS, ...SPOT_STATUS]);

const markets: Handler = async (ctx) => {
  const { svc, url } = ctx;
  const dep = requireDeployment(svc.chain);
  const kindRaw = url.searchParams.get("kind") ?? "both";
  const kind = KINDS.find((k) => k === kindRaw);
  if (!kind) throw badRequest("kind must be spot, perp or both.");
  const status = url.searchParams.get("status");
  if (status !== null && !STATUSES.has(status)) throw badRequest(`status must be one of ${[...STATUSES].join(", ")}.`);
  const limit = parseLimit(url.searchParams.get("limit"), 50, 100);
  const cursorRaw = url.searchParams.get("cursor");
  const offset = cursorRaw === null ? 0 : Number(decodeCursor("markets", cursorRaw)?.[0] ?? -1n);
  if (offset < 0) throw badRequest("cursor is malformed.");

  const anchored = await anchorBlock(svc.chain);
  const ids = await listMarketIds(svc.chain, dep, anchored.blockNumber);
  const reads = await readMarkets(svc.chain, dep, svc.tokens, ids, anchored.blockNumber);
  const views = reads.map((r) => summary(svc, dep, r, anchored, null));
  const filtered = views
    .map((v, i) => ({ v, read: reads[i] }))
    .filter(({ v }) => (kind === "perp" ? v.perp.status !== "NONE" : kind === "spot" ? v.spot.status !== "NONE" : true))
    .filter(({ v }) => {
      if (status === null) return true;
      if (kind === "perp") return v.perp.effectiveStatus === status;
      if (kind === "spot") return v.spot.status === status;
      return v.perp.effectiveStatus === status || v.spot.status === status;
    });
  const page = filtered.slice(offset, offset + limit);
  const [stats, indexer] = await Promise.all([
    stats24h(svc, page.map((p) => p.v.marketId), anchored),
    indexerFor(svc, anchored.blockNumber),
  ]);
  const body: MarketsResponse = {
    markets: page.flatMap(({ read }) => (read ? [summary(svc, dep, read, anchored, stats)] : [])),
    anchor: anchored.anchor,
    indexer,
    nextCursor: offset + limit < filtered.length ? encodeCursor("markets", [BigInt(offset + limit)]) : null,
  };
  return json(body, 200, ctx.cors);
};

const market: Handler = async (ctx) => {
  const { svc } = ctx;
  const dep = requireDeployment(svc.chain);
  const id = parseBytes32(param(ctx, "marketId"), "marketId");
  const anchored = await anchorBlock(svc.chain);
  const [read] = await readMarkets(svc.chain, dep, svc.tokens, [id], anchored.blockNumber);
  if (!read) throw notFound("Unknown market.");
  const stats = await stats24h(svc, [id], anchored);
  return json(summary(svc, dep, read, anchored, stats), 200, ctx.cors);
};

const chart: Handler = async (ctx) => {
  const { svc, url } = ctx;
  const dep = requireDeployment(svc.chain);
  const id = parseBytes32(param(ctx, "marketId"), "marketId");
  const { interval, seconds } = parseInterval(url.searchParams.get("interval"));
  const limit = parseLimit(url.searchParams.get("limit"), 500, 1_000);
  const anchored = await anchorBlock(svc.chain);
  await readMarketStructs(svc.chain, dep, [id], anchored.blockNumber);
  const chainId = svc.chain.config.chainId;
  const [pool, perp, oracle, indexer] = await Promise.all([
    history(svc.sql, (q) => tradeCandles(q, chainId, id, "swap", seconds, limit)),
    history(svc.sql, (q) => tradeCandles(q, chainId, id, "perp", seconds, limit)),
    history(svc.sql, (q) => oracleCandles(q, chainId, id, seconds, limit)),
    indexerFor(svc, anchored.blockNumber),
  ]);
  const body: ChartResponse = {
    marketId: id,
    interval,
    series: [
      { source: "pool", unit: "USD_PER_BASE", candles: toCandles(pool) },
      { source: "perp", unit: "USD_PER_BASE", candles: toCandles(perp) },
      { source: "oracle", unit: "USD_PER_BASE", candles: toCandles(oracle) },
    ],
    anchor: anchored.anchor,
    indexer,
  };
  return json(body, 200, ctx.cors);
};

const trades: Handler = async (ctx) => {
  const { svc, url } = ctx;
  const id = parseBytes32(param(ctx, "marketId"), "marketId");
  const limit = parseLimit(url.searchParams.get("limit"), 50, 200);
  const raw = url.searchParams.get("cursor");
  const parts = raw === null ? null : decodeCursor("trades", raw);
  if (raw !== null && !parts) throw badRequest("cursor is malformed.");
  const before = parts && parts[0] !== undefined && parts[1] !== undefined ? { block: parts[0], log: parts[1] } : null;
  const chainId = svc.chain.config.chainId;
  const rows = await history(svc.sql, (q) => tradesPage(q, chainId, id, before, limit + 1));
  const head = await headOrNull(svc);
  const indexer = await indexerFor(svc, head);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const body: TradesResponse = {
    trades: page.map(
      (r): TradeRow => ({
        kind: r.kind,
        txHash: r.tx_hash,
        logIndex: r.log_index,
        blockNumber: r.block_number.toString(),
        timestamp: Number(r.block_timestamp),
        account: getAddress(r.account),
        size: r.size,
        price: r.price,
        fee: r.fee,
        canonical: true,
        ...(r.fee_token ? { feeToken: getAddress(r.fee_token) } : {}),
      }),
    ),
    nextCursor: rows.length > limit && last ? encodeCursor("trades", [last.block_number, BigInt(last.log_index)]) : null,
    indexer,
  };
  return json(body, 200, ctx.cors);
};

// ------------------------------------------------------------------ account

const account: Handler = async (ctx) => {
  const { svc } = ctx;
  const dep = requireDeployment(svc.chain);
  const wallet = parseAddress(param(ctx, "wallet"), "wallet");
  const chainId = svc.chain.config.chainId;
  const anchored = await anchorBlock(svc.chain);
  const ids = await listMarketIds(svc.chain, dep, anchored.blockNumber);
  const [structs, seen, collateral, collateralMeta, indexer] = await Promise.all([
    readMarketStructs(svc.chain, dep, ids, anchored.blockNumber),
    optionalHistory(svc.sql, (q) => takerMarkets(q, chainId, wallet)),
    readCollateral(svc.chain, dep, wallet, anchored.blockNumber),
    svc.tokens.get(dep.collateral),
    indexerFor(svc, anchored.blockNumber),
  ]);
  const known = new Set(ids.map((i) => i.toLowerCase()));
  // Indexer down: fall back to checking every market onchain rather than showing no positions.
  const candidates = seen === null ? ids : seen.filter((m) => known.has(m.toLowerCase()));
  const bases = structs.map((s) => s.base);
  const [positions, lp, balances, baseMetas] = await Promise.all([
    readPositions(svc.chain, dep, wallet, candidates, anchored.blockNumber),
    readLp(svc.chain, wallet, structs, anchored.blockNumber),
    readBalances(svc.chain, wallet, bases, anchored.blockNumber),
    Promise.all(bases.map((b) => svc.tokens.get(b))),
  ]);
  const seenBases = new Set<string>();
  const holdings = baseMetas.flatMap((meta) => {
    const key = meta.address.toLowerCase();
    const balance = balances.get(key) ?? 0n;
    if (balance === 0n || seenBases.has(key)) return [];
    seenBases.add(key);
    return [{ asset: assetView(meta, chainId, dep), balance: balance.toString() }];
  });
  const body: AccountResponse = {
    wallet,
    collateral: {
      token: getAddress(dep.collateral),
      symbol: collateralMeta.symbol,
      decimals: collateralMeta.decimals,
      wallet: collateral.walletBalance.toString(),
      vaultFree: collateral.vaultFree.toString(),
      vaultLocked: collateral.vaultLocked.toString(),
    },
    positions: positions.map(positionView),
    lp,
    holdings,
    anchor: anchored.anchor,
    indexer,
  };
  return json(body, 200, ctx.cors);
};

const activity: Handler = async (ctx) => {
  const { svc, url } = ctx;
  const dep = requireDeployment(svc.chain);
  const wallet = parseAddress(param(ctx, "wallet"), "wallet");
  const limit = parseLimit(url.searchParams.get("limit"), 50, 200);
  const raw = url.searchParams.get("cursor");
  const parts = raw === null ? null : decodeCursor("activity", raw);
  if (raw !== null && !parts) throw badRequest("cursor is malformed.");
  const before = parts && parts[0] !== undefined && parts[1] !== undefined && parts[2] !== undefined ? { block: parts[0], log: parts[1], id: parts[2] } : null;
  const chainId = svc.chain.config.chainId;
  const [rows, meta] = await Promise.all([
    history(svc.sql, (q) => activityPage(q, chainId, wallet, before, limit + 1)),
    history(svc.sql, (q) => tokenMeta(q, chainId)),
  ]);
  const head = await headOrNull(svc);
  const indexer = await indexerFor(svc, head);
  const collateralMeta = meta.get(dep.collateral.toLowerCase());
  const ctxFormat = {
    wallet,
    tokens: meta,
    collateral: { address: dep.collateral, symbol: collateralMeta?.symbol ?? dep.collateralSymbol, decimals: collateralMeta?.decimals ?? dep.collateralDecimals },
    finality: finality(svc.cfg),
  };
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const body: ActivityResponse = {
    wallet,
    items: page.map((r) => activityRow(r, ctxFormat)),
    nextCursor: rows.length > limit && last ? encodeCursor("activity", [last.block_number, BigInt(last.log_index), last.id]) : null,
    indexer,
  };
  return json(body, 200, ctx.cors);
};

// ------------------------------------------------------------------ quotes and preflight

const perpQuote: Handler = async (ctx) => {
  rateLimit(ctx);
  const body = await readBodyText(ctx.req);
  let res: Response;
  try {
    res = await fetch(`${ctx.svc.cfg.makerUrl}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ctx.ip },
      body,
      signal: AbortSignal.timeout(4_000),
    });
  } catch (error) {
    logError("maker_unreachable", error);
    throw networkDelayed("The maker quote service did not answer.");
  }
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...ctx.cors },
  });
};

const spotQuote: Handler = async (ctx) => {
  rateLimit(ctx);
  const { svc } = ctx;
  const dep = requireDeployment(svc.chain);
  const body = await readJsonObject(ctx.req);
  if (!Array.isArray(body.path) || body.path.length < 2 || body.path.length > 3) throw badRequest("path must list 2 or 3 token addresses.");
  const path = body.path.map((p: unknown, i: number) => parseAddress(p, `path[${i}]`));
  if (!Array.isArray(body.fees) || body.fees.length !== path.length - 1) throw badRequest("fees must have one entry per hop.");
  const fees = body.fees.map((f: unknown, i: number) => parseSmallInt(f, `fees[${i}]`, 0, 65_535));
  const amountIn = parseUint(body.amountIn, "amountIn", { min: 1n });
  const slippageBps = parseSmallInt(body.slippageBps, "slippageBps", 0, 10_000);

  const anchored = await anchorBlock(svc.chain);
  const blockNumber = anchored.blockNumber;
  const amountOut = await svc.chain.client.readContract({
    address: dep.spotRouter,
    abi: spotRouterAbi,
    functionName: "quoteExactInput",
    args: [path, fees, amountIn],
    blockNumber,
  });
  const hops: Hop[] = await Promise.all(
    fees.map(async (fee, i) => {
      const tokenIn = path[i];
      const tokenOut = path[i + 1];
      if (!tokenIn || !tokenOut) throw badRequest("path and fees do not line up.");
      const pool = await svc.chain.client.readContract({ address: dep.spotFactory, abi: spotFactoryAbi, functionName: "getPool", args: [tokenIn, tokenOut, fee], blockNumber });
      if (pool === zeroAddress) throw notFound("No Rooq pool for this route.");
      const p = await readPool(svc.chain, pool, blockNumber);
      const inIs0 = p.token0.toLowerCase() === tokenIn.toLowerCase();
      return { reserveIn: inIs0 ? p.reserve0 : p.reserve1, reserveOut: inIs0 ? p.reserve1 : p.reserve0, feeBps: p.feeBps };
    }),
  );
  const perHop = hopFees(amountIn, hops);
  const response: SpotQuoteResponse = {
    path,
    fees,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    minOut: minReceived(amountOut, BigInt(slippageBps)).toString(),
    priceImpactBps: routePriceImpactBps(amountIn, amountOut, hops),
    feeAmount: (perHop[0] ?? 0n).toString(),
    route: "rooq-pool",
    expiresAt: Number(anchored.timestamp) + svc.cfg.spotQuoteTtlSeconds,
    anchor: anchored.anchor,
    hopFees: perHop.map((f) => f.toString()),
  };
  return json(response, 200, ctx.cors);
};

function preflightBody(mask: bigint, verdict: number, anchored: Anchored): PreflightResponse {
  const name = PREFLIGHT_VERDICT[verdict];
  if (!name) throw new Error(`unknown preflight verdict ${verdict}`);
  return {
    verdict: name,
    mask: mask.toString(),
    checks: PREFLIGHT_CHECKS.map((c) => ({ key: c.key, label: c.label, passed: (mask & c.bit) !== 0n })),
    notReserved: true,
    anchor: anchored.anchor,
  };
}

const preflightAsset: Handler = async (ctx) => {
  rateLimit(ctx);
  const { svc } = ctx;
  const dep = requireDeployment(svc.chain);
  const b = await readJsonObject(ctx.req);
  const input = {
    base: parseAddress(b.base, "base"),
    quote: parseAddress(b.quote, "quote"),
    feedId: parseBytes32(b.feedId, "feedId"),
    tierId: parseSmallInt(b.tierId, "tierId", 0, 65_535),
    plannedBacking: parseUint(b.plannedBacking, "plannedBacking"),
    plannedBond: parseUint(b.plannedBond, "plannedBond"),
    plannedSpotQuote: parseUint(b.plannedSpotQuote, "plannedSpotQuote"),
  };
  const anchored = await anchorBlock(svc.chain);
  const [mask, verdict] = await svc.chain.client.readContract({
    address: dep.marketPreflight,
    abi: marketPreflightAbi,
    functionName: "previewAsset",
    args: [input],
    blockNumber: anchored.blockNumber,
  });
  return json(preflightBody(mask, verdict, anchored), 200, ctx.cors);
};

const preflightMarket: Handler = async (ctx) => {
  const { svc } = ctx;
  const dep = requireDeployment(svc.chain);
  const id = parseBytes32(param(ctx, "marketId"), "marketId");
  const anchored = await anchorBlock(svc.chain);
  const [mask, verdict] = await svc.chain.client.readContract({
    address: dep.marketPreflight,
    abi: marketPreflightAbi,
    functionName: "previewEligibility",
    args: [id],
    blockNumber: anchored.blockNumber,
  });
  return json(preflightBody(mask, verdict, anchored), 200, ctx.cors);
};

// ------------------------------------------------------------------ transactions, oracle, fees

const transaction: Handler = async (ctx) => {
  const { svc } = ctx;
  const hash = parseBytes32(param(ctx, "hash"), "hash");
  await svc.chain.verified();
  const client = svc.chain.client;
  const [receipt, head] = await Promise.all([
    client.getTransactionReceipt({ hash }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
      throw error;
    }),
    client.getBlockNumber({ cacheTime: 0 }),
  ]);
  const explorerUrl = explorerTxUrl(svc.chain.config, hash);
  const tier = finality(svc.cfg);
  if (receipt) {
    const body: TransactionResponse = {
      hash,
      state: receipt.status === "success" ? "mined" : "reverted",
      finality: tier,
      blockNumber: receipt.blockNumber.toString(),
      confirmations: Number(head - receipt.blockNumber + 1n),
      explorerUrl,
    };
    return json(body, 200, ctx.cors);
  }
  const pending = await client.getTransaction({ hash }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "TransactionNotFoundError") return null;
    throw error;
  });
  const sightings = pending ? null : await optionalHistory(svc.sql, (q) => txSightings(q, svc.chain.config.chainId, hash));
  const orphaned = sightings?.find((s) => !s.canonical) ?? null;
  const body: TransactionResponse = {
    hash,
    state: pending ? "pending" : orphaned ? "rechecking" : "notSeen",
    finality: tier,
    blockNumber: orphaned ? orphaned.block_number.toString() : null,
    confirmations: 0,
    explorerUrl,
  };
  return json(body, 200, ctx.cors);
};

const oracle: Handler = async (ctx) => {
  const { svc } = ctx;
  const dep = requireDeployment(svc.chain);
  const id = parseBytes32(param(ctx, "marketId"), "marketId");
  const anchored = await anchorBlock(svc.chain);
  const [m] = await readMarketStructs(svc.chain, dep, [id], anchored.blockNumber);
  if (!m) throw notFound("Unknown market.");
  const read = await readOracle(svc.chain, dep, m.feedId, anchored.blockNumber);
  if (!read) throw notFound("This market has no price feed.");
  return json(oracleView(read, anchored.timestamp, dep), 200, ctx.cors);
};

const fees: Handler = async (ctx) => {
  const { svc } = ctx;
  const dep = requireDeployment(svc.chain);
  const id = parseBytes32(param(ctx, "marketId"), "marketId");
  const anchored = await anchorBlock(svc.chain);
  const [m] = await readMarketStructs(svc.chain, dep, [id], anchored.blockNumber);
  if (!m) throw notFound("Unknown market.");
  const [pool, accrued] = await Promise.all([
    readPool(svc.chain, m.pool, anchored.blockNumber),
    svc.chain.client.readContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "balanceOf", args: [FEES_DOMAIN, zeroAddress], blockNumber: anchored.blockNumber }),
  ]);
  const body: FeesResponse = {
    marketId: m.id,
    takerFeeBps: m.risk.takerFeeBps,
    makerFeeBps: m.risk.makerFeeBps,
    poolFeeBps: pool.feeBps,
    liqPenaltyBps: m.risk.liqPenaltyBps,
    protocolFeesAccrued: accrued.toString(),
    anchor: anchored.anchor,
  };
  return json(body, 200, ctx.cors);
};

// ------------------------------------------------------------------ health and status

interface HealthBuild {
  readonly health: HealthResponse;
  readonly reads: readonly MarketRead[];
  readonly anchored: Anchored | null;
}

async function makerProbe(cfg: ApiConfig): Promise<{ ok: boolean; status: string | null }> {
  try {
    const res = await fetch(`${cfg.makerUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    const body: unknown = await res.json();
    const status = typeof body === "object" && body !== null && "status" in body && typeof body.status === "string" ? body.status : null;
    return { ok: res.ok && status === "quoting", status };
  } catch (error) {
    logError("maker_health_unreachable", error);
    return { ok: false, status: null };
  }
}

async function buildHealth(svc: Services): Promise<HealthBuild> {
  const started = performance.now();
  const dep = svc.chain.deployment;
  const chainPart = (async () => {
    const anchored = await anchorBlock(svc.chain);
    const latencyMs = Math.round(performance.now() - started);
    if (!dep) return { anchored, latencyMs, reads: [] };
    const ids = await listMarketIds(svc.chain, dep, anchored.blockNumber);
    return { anchored, latencyMs, reads: await readMarkets(svc.chain, dep, svc.tokens, ids, anchored.blockNumber) };
  })().catch((error: unknown) => {
    logError("health_chain_read_failed", error);
    return null;
  });
  const [chainRead, maker] = await Promise.all([chainPart, makerProbe(svc.cfg)]);
  const head = chainRead?.anchored.blockNumber ?? null;
  const indexer = await indexerFor(svc, head);
  const reads = chainRead?.reads ?? [];
  const timestamp = chainRead?.anchored.timestamp ?? 0n;
  const health: HealthResponse = {
    version: svc.version,
    env: svc.cfg.env,
    chainId: svc.chain.config.chainId,
    rpc: { ok: chainRead !== null, latencyMs: chainRead?.latencyMs ?? null, headBlock: head === null ? null : head.toString() },
    indexer,
    maker,
    oracles: reads.flatMap((r) => {
      if (!r.oracle) return [];
      const view = oracleView(r.oracle, timestamp, dep);
      return [{ marketId: r.market.id, symbol: r.base.symbol, fresh: view.fresh, ageSeconds: view.ageSeconds }];
    }),
    markets: reads.map((r) => ({
      marketId: r.market.id,
      symbol: r.base.symbol,
      perpStatus: perpStatusName(r.market.perpStatus),
      spotStatus: spotStatusName(r.market.spotStatus, r.pool.paused),
    })),
    checkedAt: new Date().toISOString(),
  };
  return { health, reads, anchored: chainRead?.anchored ?? null };
}

const health: Handler = async (ctx) => json((await buildHealth(ctx.svc)).health, 200, ctx.cors);

const status: Handler = async (ctx) => {
  const { svc } = ctx;
  const chainId = svc.chain.config.chainId;
  const dep = svc.chain.deployment;
  const [built, changes, reconciliation, reorg] = await Promise.all([
    buildHealth(svc),
    optionalHistory(svc.sql, (q) => lastStatusChanges(q, chainId)),
    optionalHistory(svc.sql, (q) => lastReconciliation(q, chainId)),
    optionalHistory(svc.sql, (q) => lastReorg(q, chainId)),
  ]);
  const timestamp = built.anchored?.timestamp ?? 0n;
  const marketStatus: MarketStatusDetail[] = built.reads.map((r) => {
    const view = r.oracle ? oracleView(r.oracle, timestamp, dep) : null;
    const perpStatus = perpStatusName(r.market.perpStatus);
    const change = changes?.get(r.market.id.toLowerCase()) ?? null;
    const from = change ? PERP_STATUS.find((s) => s === change.from_status) : undefined;
    const to = change ? PERP_STATUS.find((s) => s === change.to_status) : undefined;
    return {
      marketId: r.market.id,
      symbol: r.base.symbol,
      perpStatus,
      effectiveStatus: effectiveStatus(perpStatus, view),
      spotStatus: spotStatusName(r.market.spotStatus, r.pool.paused),
      oracleFresh: view ? view.fresh : null,
      oracleAgeSeconds: view ? view.ageSeconds : null,
      heartbeatSeconds: view ? view.heartbeatSeconds : null,
      lastStatusChange: change && from && to ? { from, to, blockNumber: change.block_number.toString(), txHash: change.tx_hash } : null,
    };
  });
  const body: StatusResponse = {
    ...built.health,
    marketStatus,
    lastReconciliation: reconciliation
      ? {
          blockNumber: reconciliation.block_number.toString(),
          ok: reconciliation.ok,
          checks: reconciliation.checks,
          mismatches: reconciliation.mismatches,
          error: reconciliation.error,
          at: reconciliation.created_at.toISOString(),
        }
      : null,
    lastReorg: reorg
      ? { commonAncestor: reorg.common_ancestor.toString(), depth: reorg.depth, orphanedEvents: reorg.orphaned_events, detectedAt: reorg.detected_at.toISOString() }
      : null,
  };
  return json(body, 200, ctx.cors);
};

// ------------------------------------------------------------------ stream

const stream: Handler = async (ctx) => {
  const { svc, url, req } = ctx;
  const lastEventId = parseLastEventId(req.headers.get("last-event-id") ?? url.searchParams.get("lastEventId"));
  const marketRaw = url.searchParams.get("marketId");
  const marketId = marketRaw === null ? null : parseBytes32(marketRaw, "marketId");
  ctx.server.timeout(req, 0);
  return openStream(svc.sql, svc.chain.config.chainId, { lastEventId, marketId, signal: req.signal, headers: ctx.cors });
};

// ------------------------------------------------------------------ table

interface Route {
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  readonly keys: readonly string[];
  readonly handler: Handler;
  /** Streaming responses outlive the per-request deadline. */
  readonly streaming?: boolean;
}

function route(method: Route["method"], path: string, handler: Handler, streaming = false): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^/api/v1${path.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
      keys.push(key);
      return "([^/]+)";
    })}/?$`,
  );
  return { method, pattern, keys, handler, streaming };
}

export const ROUTES: readonly Route[] = [
  route("GET", "/health", health),
  route("GET", "/status", status),
  route("GET", "/markets", markets),
  route("GET", "/markets/:marketId", market),
  route("GET", "/markets/:marketId/chart", chart),
  route("GET", "/markets/:marketId/trades", trades),
  route("GET", "/account/:wallet", account),
  route("GET", "/account/:wallet/activity", activity),
  route("POST", "/quotes/perps", perpQuote),
  route("POST", "/quotes/spot", spotQuote),
  route("POST", "/preflight", preflightAsset),
  route("GET", "/preflight/:marketId", preflightMarket),
  route("GET", "/transactions/:hash", transaction),
  route("GET", "/oracle/:marketId", oracle),
  route("GET", "/fees/:marketId", fees),
  route("GET", "/stream", stream, true),
];

export type Match = { readonly route: Route; readonly params: Record<string, string> } | { readonly route: null; readonly methodMismatch: boolean };

export function matchRoute(method: string, pathname: string): Match {
  let methodMismatch = false;
  for (const r of ROUTES) {
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    if (r.method !== method) {
      methodMismatch = true;
      continue;
    }
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1] ?? "");
    });
    return { route: r, params };
  }
  return { route: null, methodMismatch };
}
