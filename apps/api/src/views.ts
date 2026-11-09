import { getAddress, type Address, type Hex } from "viem";
import { TESTNET_STOCK_TOKENS, TESTNET_USDG, type DeployedMarket, type Deployment, type VerifiedAsset } from "@rooq/config";
import {
  BPS,
  PERP_STATUS,
  SPOT_STATUS,
  WAD,
  getAmountOut,
  notionalUp,
  priceImpactBps,
  type AssetView,
  type OracleView,
  type PerpView,
  type RiskView,
  type SpotView,
} from "@rooq/sdk";
import riskConfig from "../../../config/risk-testnet.json";

/** Assets whose identity was verified against a first-party source. WETH is recorded but unverified. */
const CANONICAL: readonly VerifiedAsset[] = [...TESTNET_STOCK_TOKENS, TESTNET_USDG];

export const TEST_RELAY_SOURCE = "TEST relay of api.robinhood.com/rhj/prices";
export const UNLISTED_FEED_SOURCE = "Unlisted aggregator (not in the Rooq deployment record)";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface TokenMeta {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

/**
 * Verified status and logo come only from an exact (chainId, address) match in packages/config
 * tokens.ts. Rooq's own mocks are test fixtures; anything else is an unverified token.
 */
export function assetView(meta: TokenMeta, chainId: number, dep: Deployment | null): AssetView {
  const canonical = CANONICAL.find((a) => a.chainId === chainId && same(a.address, meta.address));
  if (canonical) {
    return {
      address: getAddress(canonical.address),
      symbol: canonical.symbol,
      name: canonical.name,
      decimals: meta.decimals,
      assetClass: canonical.assetClass,
      verified: true,
      verificationSource: canonical.verification.sourceUrl,
      logoUrl: canonical.logo?.url ?? null,
      isTestFixture: false,
    };
  }
  const mock =
    dep !== null &&
    dep.chainId === chainId &&
    ((dep.collateralMode === "mock" && same(dep.collateral, meta.address)) || dep.markets.some((m) => m.mode === "mock" && same(m.base, meta.address)));
  return {
    address: getAddress(meta.address),
    symbol: meta.symbol,
    name: meta.name,
    decimals: meta.decimals,
    assetClass: mock ? "test-fixture" : "crypto",
    verified: false,
    verificationSource: null,
    logoUrl: null,
    isTestFixture: mock,
  };
}

export function perpStatusName(code: number): PerpView["status"] {
  const status = PERP_STATUS[code];
  if (!status) throw new RangeError(`unknown perp status code ${code}`);
  return status;
}

export function spotStatusName(code: number, poolPaused: boolean): SpotView["status"] {
  const status = SPOT_STATUS[code];
  if (!status) throw new RangeError(`unknown spot status code ${code}`);
  return status === "ACTIVE" && poolPaused ? "PAUSED" : status;
}

/** ACTIVE only counts as tradeable with a fresh, readable feed; anything else is close-only for the UI. */
export function effectiveStatus(status: PerpView["status"], oracle: Pick<OracleView, "fresh"> | null): PerpView["status"] {
  if (status !== "ACTIVE") return status;
  return oracle?.fresh === true ? "ACTIVE" : "CLOSE_ONLY";
}

/** floor(10 * 1e18 / imr): 0.5e18 -> 20 (2.0x). Zero when the market has no initial margin set. */
export function maxLeverageTenths(imrWad: bigint): number {
  return imrWad === 0n ? 0 : Number((10n * WAD) / imrWad);
}

const TIER_NAMES = new Map<number, string>(riskConfig.tiers.map((t) => [t.id, t.name]));

export function tierName(tierId: number): string {
  return TIER_NAMES.get(tierId) ?? `#${tierId}`;
}

export interface RiskParams {
  readonly imrWad: bigint;
  readonly mmrWad: bigint;
  readonly maxOiUsdWad: bigint;
  readonly takerFeeBps: number;
  readonly makerFeeBps: number;
  readonly liqPenaltyBps: number;
  readonly maxDeviationBps: number;
  readonly maxFundingRatePerHourWad: bigint;
  readonly minMakerBacking: bigint;
  readonly minBond: bigint;
  readonly version: number;
}

export function riskView(tierId: number, risk: RiskParams): RiskView {
  return {
    tierId,
    tierName: tierName(tierId),
    imrWad: risk.imrWad.toString(),
    mmrWad: risk.mmrWad.toString(),
    maxLeverageTenths: maxLeverageTenths(risk.imrWad),
    maxOiUsdWad: risk.maxOiUsdWad.toString(),
    takerFeeBps: risk.takerFeeBps,
    makerFeeBps: risk.makerFeeBps,
    liqPenaltyBps: risk.liqPenaltyBps,
    maxDeviationBps: risk.maxDeviationBps,
    maxFundingRatePerHourWad: risk.maxFundingRatePerHourWad.toString(),
    minMakerBacking: risk.minMakerBacking.toString(),
    minBond: risk.minBond.toString(),
    version: risk.version,
  };
}

export interface OracleRead {
  readonly feedId: Hex;
  readonly aggregator: Address;
  readonly priceWad: bigint;
  readonly updatedAt: bigint;
  readonly fresh: boolean;
  readonly heartbeat: number;
}

export function feedLabel(dep: Deployment | null, aggregator: Address): { source: string; isTestFeed: boolean; entry: DeployedMarket | null } {
  const entry = dep?.markets.find((m) => m.feedMode === "relay" && same(m.feed, aggregator)) ?? null;
  return entry ? { source: TEST_RELAY_SOURCE, isTestFeed: true, entry } : { source: UNLISTED_FEED_SOURCE, isTestFeed: true, entry: null };
}

/** Unknown values are null, never zero. Age is measured against the anchor block's timestamp. */
export function oracleView(read: OracleRead, blockTimestamp: bigint, dep: Deployment | null): OracleView {
  const label = feedLabel(dep, read.aggregator);
  const heartbeat = label.entry ? Number(label.entry.heartbeat) : read.heartbeat;
  const updatedAt = read.updatedAt === 0n ? null : Number(read.updatedAt);
  return {
    feedId: read.feedId,
    feed: getAddress(read.aggregator),
    price: read.priceWad === 0n ? null : read.priceWad.toString(),
    updatedAt,
    ageSeconds: updatedAt === null ? null : Math.max(0, Number(blockTimestamp) - updatedAt),
    heartbeatSeconds: heartbeat,
    fresh: read.fresh,
    source: label.source,
    isTestFeed: label.isTestFeed,
  };
}

/** Marginal pool price in 18-decimal quote per base; null when either side is unfunded. */
export function poolPriceWad(reserveBase: bigint, reserveQuote: bigint, baseDecimals: number, quoteDecimals: number): bigint | null {
  if (reserveBase === 0n || reserveQuote === 0n) return null;
  return (reserveQuote * 10n ** BigInt(18 - quoteDecimals) * WAD) / (reserveBase * 10n ** BigInt(18 - baseDecimals));
}

export interface PoolRead {
  readonly pool: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly feeBps: number;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly lpSupply: bigint;
  readonly feesAccrued0: bigint;
  readonly feesAccrued1: bigint;
  readonly paused: boolean;
}

export function spotView(pool: PoolRead, spotStatus: number, base: TokenMeta, quote: TokenMeta): SpotView {
  const baseIs0 = same(pool.token0, base.address);
  const [reserveBase, reserveQuote] = baseIs0 ? [pool.reserve0, pool.reserve1] : [pool.reserve1, pool.reserve0];
  const price = poolPriceWad(reserveBase, reserveQuote, base.decimals, quote.decimals);
  return {
    pool: getAddress(pool.pool),
    status: spotStatusName(spotStatus, pool.paused),
    feeBps: pool.feeBps,
    token0: getAddress(pool.token0),
    token1: getAddress(pool.token1),
    reserve0: pool.reserve0.toString(),
    reserve1: pool.reserve1.toString(),
    lpSupply: pool.lpSupply.toString(),
    poolPrice: price === null ? null : price.toString(),
    feesAccrued0: pool.feesAccrued0.toString(),
    feesAccrued1: pool.feesAccrued1.toString(),
  };
}

export interface PerpRead {
  readonly status: number;
  readonly tierId: number;
  readonly risk: RiskParams;
  readonly longOi: bigint;
  readonly shortOi: bigint;
  readonly makerBacking: bigint;
  readonly badDebt: bigint;
  readonly fundingRatePerSecondWad: bigint;
  readonly fundingIndex: bigint;
  readonly lastFundingTime: bigint;
  readonly insurance: bigint;
  readonly creatorBond: bigint;
}

export function perpView(read: PerpRead, oracle: OracleView | null): PerpView {
  const status = perpStatusName(read.status);
  const mark = oracle?.price === null || oracle?.price === undefined ? null : BigInt(oracle.price);
  return {
    status,
    effectiveStatus: effectiveStatus(status, oracle),
    longOi: read.longOi.toString(),
    shortOi: read.shortOi.toString(),
    oiUsdWad: mark === null ? null : notionalUp(read.longOi + read.shortOi, mark).toString(),
    makerBacking: read.makerBacking.toString(),
    badDebt: read.badDebt.toString(),
    fundingRatePerSecondWad: read.fundingRatePerSecondWad.toString(),
    fundingIndex: read.fundingIndex.toString(),
    lastFundingTime: Number(read.lastFundingTime),
    insurance: read.insurance.toString(),
    creatorBond: read.creatorBond.toString(),
    risk: status === "NONE" ? null : riskView(read.tierId, read.risk),
    oracle,
  };
}

/** Signed WAD change from the reference price (last trade before the window, else the window's first). */
export function change24hWad(refPrice: bigint | null, firstPrice: bigint | null, lastPrice: bigint | null): bigint | null {
  const ref = refPrice ?? firstPrice;
  if (ref === null || lastPrice === null || ref === 0n) return null;
  return ((lastPrice - ref) * WAD) / ref;
}

export interface Hop {
  readonly reserveIn: bigint;
  readonly reserveOut: bigint;
  readonly feeBps: number;
}

/**
 * Price impact of a route from reserves only: compares the output at each pool's marginal price
 * (before the trade) with the actual output. Single hops use the SDK helper unchanged.
 */
export function routePriceImpactBps(amountIn: bigint, amountOut: bigint, hops: readonly Hop[]): number {
  const [first] = hops;
  if (first && hops.length === 1) return Number(priceImpactBps(amountIn, amountOut, first.reserveIn, first.reserveOut));
  let ideal = amountIn;
  for (const hop of hops) {
    if (hop.reserveIn === 0n || hop.reserveOut === 0n) return Number(BPS);
    ideal = (ideal * hop.reserveOut) / hop.reserveIn;
  }
  if (ideal === 0n) return 0;
  return Number(((ideal - amountOut) * BPS) / ideal);
}

/** Fee each hop charges in its own input token, following the pools' rounding. */
export function hopFees(amountIn: bigint, hops: readonly Hop[]): bigint[] {
  const fees: bigint[] = [];
  let amount = amountIn;
  for (const hop of hops) {
    fees.push((amount * BigInt(hop.feeBps)) / BPS);
    amount = getAmountOut(amount, hop.reserveIn, hop.reserveOut, BigInt(hop.feeBps));
  }
  return fees;
}
