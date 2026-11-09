import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fee, fundingIndexDelta, fundingOwed, fundingRatePerSecond, marginRequirement, pnlFloor, pnlTrunc, weightedEntry } from "../src/risk";
import { getAmountOut, sqrt } from "../src/spot";

type Case = Record<string, string>;
const vectors = JSON.parse(
  readFileSync(join(__dirname, "../../../contracts/test/vectors/risk_vectors.json"), "utf8"),
) as { cases: Record<string, Case[]> };
const b = (x: string | undefined): bigint => BigInt(x ?? "0");
const cases = (key: string): Case[] => vectors.cases[key] ?? [];

describe("T-015 TypeScript estimator parity with Rust kernel and Solidity", () => {
  it("marginRequirement", () => {
    const cs = cases("marginRequirement");
    expect(cs.length).toBe(200);
    for (const c of cs) expect(marginRequirement(b(c.absSize), b(c.price), b(c.fraction), b(c.scale))).toBe(b(c.expected));
  });
  it("fee", () => {
    for (const c of cases("fee")) expect(fee(b(c.absSize), b(c.price), b(c.bps), b(c.scale))).toBe(b(c.expected));
  });
  it("pnl trunc and floor", () => {
    for (const c of cases("pnl")) {
      expect(pnlTrunc(b(c.size), b(c.entry), b(c.exit), b(c.scale))).toBe(b(c.trunc));
      expect(pnlFloor(b(c.size), b(c.entry), b(c.exit), b(c.scale))).toBe(b(c.floor));
    }
  });
  it("weightedEntry", () => {
    for (const c of cases("weightedEntry")) expect(weightedEntry(b(c.absOld), b(c.oldEntry), b(c.absAdd), b(c.addPrice))).toBe(b(c.expected));
  });
  it("funding", () => {
    for (const c of cases("fundingRate")) expect(fundingRatePerSecond(b(c.longOi), b(c.shortOi), b(c.maxPerHour))).toBe(b(c.expected));
    for (const c of cases("funding")) {
      const delta = fundingIndexDelta(b(c.rate), b(c.dt), b(c.price));
      expect(delta).toBe(b(c.delta));
      expect(fundingOwed(b(c.size), delta, b(c.scale))).toBe(b(c.owed));
    }
  });
  it("spot", () => {
    for (const c of cases("amountOut")) expect(getAmountOut(b(c.amountIn), b(c.reserveIn), b(c.reserveOut), b(c.feeBps))).toBe(b(c.expected));
    for (const c of cases("sqrt")) expect(sqrt(b(c.x))).toBe(b(c.expected));
  });
});
