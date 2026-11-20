/**
 * Price bands for private liquidity. The lp_add and lp_remove circuits run an intent only while the pool price
 * P = r1 * WAD / r0 (WAD-scaled token1 base units per token0 base unit) sits inside the band the owner committed, so the
 * wallet's job is to pick that band from what it can see: an operator quote, the person's own deposit ratio, and where a
 * token has a perps feed, the oracle mark.
 */
import { PRICE_NO_LOWER, PRICE_NO_UPPER, WAD, type PriceBand } from "@rooq/private-sdk";

export { bandForDeposit, bandFromQuote, inBand, midPriceBand, PRICE_NO_LOWER, PRICE_NO_UPPER, removalEstimate, type Price, type PriceBand } from "@rooq/private-sdk";

const BPS = 10_000n;

export interface WadBand {
  readonly lo: bigint;
  readonly hi: bigint;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a === 0n ? 0n : (a - 1n) / b + 1n);
const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** A quote's mid-price band as WAD integers, without slippage: the range the true pool price is in. */
export function midBandWad(band: PriceBand): WadBand {
  return { lo: (band.low.num * WAD) / band.low.den, hi: ceilDiv(band.high.num * WAD, band.high.den) };
}

/** Pool units to what a person reads: WAD-scaled whole token1 per whole token0. */
export const toHumanPrice = (poolWad: bigint, decimals0: number, decimals1: number): bigint => (poolWad * pow10(decimals0)) / pow10(decimals1);

/** What a person typed back to pool units, rounded outward so the band they see is never narrower than what they get. */
export function fromHumanPrice(humanWad: bigint, decimals0: number, decimals1: number, round: "down" | "up"): bigint {
  const num = humanWad * pow10(decimals1);
  const den = pow10(decimals0);
  return round === "down" ? num / den : ceilDiv(num, den);
}

/**
 * The oracle mark (WAD USD per whole stock token) in pool units, for a pool of the stock against the dollar collateral.
 * Treats the collateral as one dollar, which is all a sanity check against an operator quote needs.
 */
export function markInPoolUnits(markWad: bigint, stockIsToken0: boolean, decimals0: number, decimals1: number): bigint {
  if (markWad <= 0n) throw new RangeError("mark");
  return stockIsToken0 ? (markWad * pow10(decimals1)) / pow10(decimals0) : (WAD * WAD * pow10(decimals1)) / (markWad * pow10(decimals0));
}

/**
 * How far the quote may sit from the oracle before Rooq warns, and before it refuses. The band the person signs is the
 * quote widened by their slippage, so a quote further than that from the oracle means the band may not contain the fair
 * price: warn. Past twice the slippage it has stopped being lag and the band would be built around the operator's own
 * number: refuse. The refusal never drops under 1%, because the pool keeps trading while the stock feed is stale
 * (weekends, the 1 hour heartbeat) and arbitrage only closes gaps wider than the pool fee, so an honest pool can sit
 * a fraction of a percent off the mark and a tight slippage setting must not lock people out of it.
 */
export function markBounds(slippageBps: number): { readonly warnBps: bigint; readonly refuseBps: bigint } {
  const s = BigInt(slippageBps);
  return { warnBps: s, refuseBps: 2n * s > 100n ? 2n * s : 100n };
}

/** The oracle side of the check, from the chain. `price` is in pool units. */
export type MarkReading =
  | { readonly kind: "no_feed" }
  /** The token has a feed, but the oracle has no valid price for it. */
  | { readonly kind: "no_price" }
  | { readonly kind: "price"; readonly price: bigint; readonly fresh: boolean };

export type MarkCheck =
  | { readonly kind: "no_feed" }
  | { readonly kind: "no_price" }
  | { readonly kind: "ok"; readonly stale: boolean }
  | { readonly kind: "warn"; readonly offBps: bigint }
  | { readonly kind: "refuse"; readonly offBps: bigint; readonly stale: boolean };

/** How far the mark lies outside `mid` (WAD pool units), in bps of the mark, rounded up. Zero when inside. */
export function offMarkBps(mid: WadBand, mark: bigint): bigint {
  if (mark <= 0n) throw new RangeError("mark");
  if (mark < mid.lo) return ceilDiv((mid.lo - mark) * BPS, mark);
  if (mark > mid.hi) return ceilDiv((mark - mid.hi) * BPS, mark);
  return 0n;
}

/**
 * Cross-checks an operator quote (or a first depositor's own ratio) against the oracle mark in pool units. A stale mark
 * is the last price the oracle accepted: the stock may have moved since, so it only refuses, past the refuse bound.
 */
export function checkAgainstMark(mid: WadBand, mark: MarkReading, slippageBps: number): MarkCheck {
  if (mark.kind !== "price") return mark;
  const off = offMarkBps(mid, mark.price);
  const { warnBps, refuseBps } = markBounds(slippageBps);
  if (off > refuseBps) return { kind: "refuse", offBps: off, stale: !mark.fresh };
  if (mark.fresh && off > warnBps) return { kind: "warn", offBps: off };
  return { kind: "ok", stale: !mark.fresh };
}

/** Whether Rooq may suggest a range: only after an on-chain price, fresh or last known, agrees with it, or with no feed to check. */
export const maySuggest = (check: MarkCheck): boolean => check.kind === "ok" || check.kind === "warn" || check.kind === "no_feed";

/**
 * The oracle reading for a pool, from on-chain values: the market's collateral must be one side of the pool, and a price
 * of 0 or an update time of 0 is the oracle saying it has no valid answer.
 */
export function readingFor(
  feed: { readonly collateral: string; readonly price: bigint; readonly updatedAt: bigint; readonly fresh: boolean } | null,
  token0: string, token1: string, decimals0: number, decimals1: number,
): MarkReading {
  if (!feed) return { kind: "no_feed" };
  const collateral = feed.collateral.toLowerCase();
  if (collateral !== token0.toLowerCase() && collateral !== token1.toLowerCase()) return { kind: "no_feed" };
  if (feed.price <= 0n || feed.updatedAt === 0n) return { kind: "no_price" };
  return { kind: "price", price: markInPoolUnits(feed.price, collateral === token1.toLowerCase(), decimals0, decimals1), fresh: feed.fresh };
}

/** Which edges of a band are open. */
export const openLow = (band: WadBand): boolean => band.lo === PRICE_NO_LOWER;
export const openHigh = (band: WadBand): boolean => band.hi === PRICE_NO_UPPER;

/**
 * A range typed in human units (WAD whole token1 per whole token0), in pool units rounded outward. Null for a side means
 * that field was left empty: no limit there. Returns null while the range isn't usable.
 */
export function typedBandOf(low: bigint | null, high: bigint | null, decimals0: number, decimals1: number): WadBand | null {
  if ((low !== null && low < 0n) || (high !== null && high <= 0n)) return null;
  const band = {
    lo: low === null ? PRICE_NO_LOWER : fromHumanPrice(low, decimals0, decimals1, "down"),
    hi: high === null ? PRICE_NO_UPPER : fromHumanPrice(high, decimals0, decimals1, "up"),
  };
  return band.hi === 0n || band.hi > PRICE_NO_UPPER || band.hi < band.lo ? null : band;
}
