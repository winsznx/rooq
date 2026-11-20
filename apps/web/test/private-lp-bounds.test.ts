import { amountOut, EMPTY_POOL, inBand, lpAddPrice, type PoolState } from "@rooq/private-sdk";
import { describe, expect, it } from "vitest";
import {
  bandForDeposit, bandFromQuote, checkAgainstMark, fromHumanPrice, markBounds, markInPoolUnits, maySuggest, midBandWad, midPriceBand, offMarkBps, PRICE_NO_LOWER, PRICE_NO_UPPER, readingFor, removalEstimate,
  toHumanPrice, typedBandOf, type MarkReading, type PriceBand,
} from "../lib/private/lp-bounds";

const FEE = 30n;
const UNIT = 10n ** 6n;
const WAD = 10n ** 18n;

/** The coordinator's quote: SpotExecutor.quote in apps/private-services, one hop. */
function quote(s: PoolState, amountIn: bigint): { amountOut: bigint; priceImpactBps: number } {
  const out = amountOut(amountIn, s.r0, s.r1, FEE);
  const impact = (out * s.r0 * 10_000n * 1_000_000n) / (amountIn * (10_000n - FEE) * s.r1);
  const digits = out.toString().length;
  const rounded = digits <= 4 ? out : (out / 10n ** BigInt(digits - 4)) * 10n ** BigInt(digits - 4);
  return { amountOut: rounded, priceImpactBps: 1_000_000n > impact ? Number((1_000_000n - impact) / 100n) : 0 };
}

function quoteBand(s: PoolState, amountIn: bigint): PriceBand {
  const q = quote(s, amountIn);
  const band = midPriceBand(amountIn, q.amountOut, FEE, q.priceImpactBps);
  if (!band) throw new Error("no band");
  return band;
}

function swap0For1(s: PoolState, amountIn: bigint): PoolState {
  const out = amountOut(amountIn, s.r0, s.r1, FEE);
  return { ...s, r0: s.r0 + amountIn, r1: s.r1 - out };
}

const pool = (r0: bigint, r1: bigint, supply: bigint): PoolState => ({ ...EMPTY_POOL, r0, r1, supply });
const runs = (s: PoolState, band: { lo: bigint; hi: bigint }, d0 = 0n, d1 = 0n): boolean => {
  const [p0, p1] = lpAddPrice(d0, d1, s);
  return inBand(p0, p1, band.lo, band.hi);
};

describe("LP add price band (audit finding 1)", () => {
  const fresh = pool(1_000_000n * UNIT, 1_000_000n * UNIT, 1_000_000n * UNIT);

  it("lets an add at the quoted price run", () => {
    expect(runs(fresh, bandFromQuote(quoteBand(fresh, UNIT), 50))).toBe(true);
  });

  it("refuses the audit's sandwich: a 1M token0 front-run before the add", () => {
    const band = bandFromQuote(quoteBand(fresh, UNIT), 50);
    expect(runs(swap0For1(fresh, 1_000_000n * UNIT), band)).toBe(false);
  });

  it("refuses a front-run just past the slippage and allows one inside it", () => {
    const band = bandFromQuote(quoteBand(fresh, UNIT), 100);
    expect(runs(swap0For1(fresh, 30_000n * UNIT), band)).toBe(false);
    expect(runs(swap0For1(fresh, 2_000n * UNIT), band)).toBe(true);
  });

  it("centres a first deposit on the depositor's ratio and refuses a pool someone seeded elsewhere", () => {
    const [d0, d1] = [100_000n * UNIT, 100_000n * UNIT];
    const band = bandForDeposit(d0, d1, 50);
    expect(runs(EMPTY_POOL, band, d0, d1)).toBe(true);
    expect(runs(pool(10_000n * UNIT, 2_500n * UNIT, 5_000n * UNIT), band, d0, d1)).toBe(false);
  });
});

describe("LP removal band (audit finding 1)", () => {
  const shares = 50_000n * UNIT;
  const removeOutcome = (s: PoolState) => ({ a0: (shares * s.r0) / s.supply, a1: (shares * s.r1) / s.supply });

  it("estimates at most what an honest removal pays, and close to it", () => {
    const s = pool(1_000_000n * UNIT, 4_000_000n * UNIT, 2_000_000n * UNIT);
    const band = bandFromQuote(quoteBand(s, UNIT), 50);
    const est = removalEstimate(shares, band);
    const out = removeOutcome(s);
    expect([runs(s, band), out.a0 >= est.out0, out.a1 >= est.out1, est.out0 * 100n > out.a0 * 98n, est.out1 * 100n > out.a1 * 98n]).toEqual([true, true, true, true, true]);
  });

  it("refuses a removal after the price was pushed", () => {
    const s = pool(1_000_000n * UNIT, 1_000_000n * UNIT, 1_000_000n * UNIT);
    expect(runs(swap0For1(s, 200_000n * UNIT), bandFromQuote(quoteBand(s, UNIT), 50))).toBe(false);
  });
});

describe("human price units", () => {
  it("shows a stock at 250 USDG when the stock is token0", () => {
    const [d0, d1] = [18, 6];
    const poolWad = (250n * 10n ** 6n * WAD) / 10n ** 18n;
    expect(toHumanPrice(poolWad, d0, d1)).toBe(250n * WAD);
  });

  it("rounds typed prices outward", () => {
    const lo = fromHumanPrice(250n * WAD + 1n, 18, 6, "down");
    const hi = fromHumanPrice(250n * WAD + 1n, 18, 6, "up");
    expect(hi - lo).toBe(1n);
    expect(toHumanPrice(lo, 18, 6)).toBeLessThanOrEqual(250n * WAD + 1n);
  });
});

const fresh = (price: bigint): MarkReading => ({ kind: "price", price, fresh: true });
const stale = (price: bigint): MarkReading => ({ kind: "price", price, fresh: false });

describe("quote against the oracle mark", () => {
  // TSLA (18 decimals) against USDG (6) at $250, stock as token0: 250 USDG per TSLA.
  const s = pool(4_000n * WAD, 1_000_000n * UNIT, 1n);
  const mark = 250n * WAD;

  it("converts the mark into pool units for both orientations", () => {
    const asToken0 = markInPoolUnits(mark, true, 18, 6);
    expect(asToken0).toBe((s.r1 * WAD) / s.r0);
    const asToken1 = markInPoolUnits(mark, false, 6, 18);
    expect(asToken1).toBe((WAD * WAD) / 250n / 10n ** 6n);
  });

  it("accepts an honest quote", () => {
    const mid = midBandWad(quoteBand(s, 10n ** 16n));
    expect(checkAgainstMark(mid, fresh(markInPoolUnits(mark, true, 18, 6)), 50)).toEqual({ kind: "ok", stale: false });
  });

  it("warns past the slippage and refuses past twice it", () => {
    const at = (price: bigint) => markInPoolUnits(price, true, 18, 6);
    const mid = midBandWad(quoteBand(s, 10n ** 16n));
    expect(checkAgainstMark(mid, fresh(at(253n * WAD)), 100).kind).toBe("warn");
    expect(checkAgainstMark(mid, fresh(at(260n * WAD)), 100).kind).toBe("refuse");
  });

  it("never refuses inside 1%, however tight the slippage", () => {
    expect(markBounds(10)).toEqual({ warnBps: 10n, refuseBps: 100n });
    expect(markBounds(300)).toEqual({ warnBps: 300n, refuseBps: 600n });
    const mid = { lo: 1_000n, hi: 1_000n };
    expect(offMarkBps(mid, 1_009n)).toBeLessThanOrEqual(100n);
    expect(checkAgainstMark(mid, fresh(1_009n), 10).kind).toBe("warn");
  });

  it("says so when the token has no feed", () => {
    expect(checkAgainstMark({ lo: 1n, hi: 2n }, { kind: "no_feed" }, 50)).toEqual({ kind: "no_feed" });
  });

  it("checks a stale mark against the refuse bound only, and suggests no range without an on-chain price", () => {
    // #given a quote whose mid is 1000 and slippage 100 bps: warn past 1%, refuse past 2%
    const mid = { lo: 1_000n, hi: 1_000n };
    // #then a stale last price 1.5% away doesn't warn, 3% away refuses, and no price at all never suggests a range
    expect(checkAgainstMark(mid, stale(1_015n), 100)).toEqual({ kind: "ok", stale: true });
    expect(checkAgainstMark(mid, stale(1_030n), 100)).toEqual({ kind: "refuse", offBps: 292n, stale: true });
    expect(checkAgainstMark(mid, { kind: "no_price" }, 100)).toEqual({ kind: "no_price" });
    expect([fresh(1_015n), stale(1_015n), stale(1_030n), { kind: "no_price" } as const, { kind: "no_feed" } as const].map((r) => maySuggest(checkAgainstMark(mid, r, 100))))
      .toEqual([true, true, false, false, true]);
  });

  it("reads the on-chain feed: no price when the oracle has no valid answer, no feed when the collateral isn't in the pool", () => {
    const [stock, usd] = ["0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000bb"];
    const feed = { collateral: usd, price: 250n * WAD, updatedAt: 1_700_000_000n, fresh: false };
    expect(readingFor(feed, stock, usd, 18, 6)).toEqual({ kind: "price", price: markInPoolUnits(250n * WAD, true, 18, 6), fresh: false });
    expect(readingFor({ ...feed, price: 0n, updatedAt: 0n }, stock, usd, 18, 6)).toEqual({ kind: "no_price" });
    expect(readingFor({ ...feed, updatedAt: 0n }, stock, usd, 18, 6)).toEqual({ kind: "no_price" });
    expect(readingFor({ ...feed, collateral: "0x00000000000000000000000000000000000000cc" }, stock, usd, 18, 6)).toEqual({ kind: "no_feed" });
    expect(readingFor(null, stock, usd, 18, 6)).toEqual({ kind: "no_feed" });
  });
});

describe("typed ranges with no limit on a side", () => {
  it("reads an empty field as no limit, and refuses an inverted or empty range", () => {
    const at = (x: bigint) => fromHumanPrice(x * WAD, 18, 6, "down");
    expect(typedBandOf(240n * WAD, 260n * WAD, 18, 6)).toEqual({ lo: at(240n), hi: fromHumanPrice(260n * WAD, 18, 6, "up") });
    expect(typedBandOf(null, 260n * WAD, 18, 6)).toEqual({ lo: PRICE_NO_LOWER, hi: fromHumanPrice(260n * WAD, 18, 6, "up") });
    expect(typedBandOf(240n * WAD, null, 18, 6)).toEqual({ lo: at(240n), hi: PRICE_NO_UPPER });
    expect(typedBandOf(null, null, 18, 6)).toEqual({ lo: PRICE_NO_LOWER, hi: PRICE_NO_UPPER });
    expect([typedBandOf(260n * WAD, 240n * WAD, 18, 6), typedBandOf(null, 0n, 18, 6), typedBandOf(1n, (1n << 200n), 18, 6)]).toEqual([null, null, null]);
  });

  it("an open range lets the add run at any price on that side", () => {
    const s = pool(1_000_000n * UNIT, 1_000_000n * UNIT, 1_000_000n * UNIT);
    const pushed = swap0For1(s, 1_000_000n * UNIT);
    expect([runs(pushed, { lo: PRICE_NO_LOWER, hi: WAD }), runs(pushed, { lo: WAD, hi: PRICE_NO_UPPER }), runs(s, { lo: PRICE_NO_LOWER, hi: PRICE_NO_UPPER })]).toEqual([true, false, true]);
  });
});

describe("quote mid band against the true pool price (re-audit fuzz)", () => {
  // The coordinator's quote reads impact from reserves cut to four significant figures (SpotExecutor.quote).
  const roundDownSig = (x: bigint): bigint => {
    const s = x.toString();
    if (s.length <= 4) return x;
    const scale = 10n ** BigInt(s.length - 4);
    return (x / scale) * scale;
  };
  function coarseImpactBps(rIn0: bigint, feeBps: bigint, amountIn: bigint): number {
    const rIn = roundDownSig(rIn0);
    const impact = (1_000_000n * ((rIn * 10_000n * 1_000_000n) / (rIn * 10_000n + amountIn * (10_000n - feeBps)))) / 1_000_000n;
    return 1_000_000n > impact ? Number((1_000_000n - impact) / 100n) : 0;
  }
  function rng(seed: number): (lo: number, hi: number) => bigint {
    let s = seed >>> 0;
    return (lo, hi) => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return BigInt(lo + Math.floor((s / 2 ** 32) * (hi - lo)));
    };
  }

  it("keeps the true price inside the mid band and the 1 bps band for every quote of 1000 base units or more", () => {
    // #given random pools across 6 and 18 decimal mixes, quoted for one whole token0
    const rnd = rng(36);
    const misses: string[] = [];
    let total = 0;
    for (let n = 0; n < 20_000; n++) {
      const d0 = [18, 6][n % 2]!;
      const d1 = [6, 18][(n >> 1) % 2]!;
      const r0 = (rnd(1, 1e6) * 10n ** BigInt(d0)) / rnd(1, 1000) + 1n;
      const r1 = (rnd(1, 1e6) * 10n ** BigInt(d1)) / rnd(1, 1000) + 1n;
      const fee = [5n, 30n, 100n][n % 3]!;
      const probe = 10n ** BigInt(d0);
      const out = amountOut(probe, r0, r1, fee);
      // #when
      const band = midPriceBand(probe, roundDownSig(out), fee, coarseImpactBps(r0, fee, probe));
      if (out < 1_000n) {
        expect(band).toBeNull();
        continue;
      }
      if (!band) continue;
      total++;
      // #then
      const mid = midBandWad(band);
      const wide = bandFromQuote(band, 1);
      if (!inBand(r0, r1, mid.lo, mid.hi) || !inBand(r0, r1, wide.lo, wide.hi)) misses.push(`r0=${r0} r1=${r1} fee=${fee}`);
    }
    expect({ enough: total > 15_000, misses }).toEqual({ enough: true, misses: [] });
  });
});
