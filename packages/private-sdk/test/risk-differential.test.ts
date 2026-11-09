import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";
import { describe, expect, it } from "vitest";
import { amountOut, floorSqrt, marginRequirement, pairPnl, positionFee, toHex32 } from "../src";

/**
 * Vectors come from crates/risk-kernel, which Foundry's RiskParity test holds equal to RiskMath.sol. Neither the
 * SDK nor the circuits call that code, so agreement here is a real three-way check.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const vectors = JSON.parse(readFileSync(`${ROOT}contracts/test/vectors/risk_vectors.json`, "utf8")) as {
  cases: {
    marginRequirement: { absSize: string; price: string; fraction: string; scale: string; expected: string }[];
    fee: { absSize: string; price: string; bps: string; scale: string; expected: string }[];
    pnl: { size: string; entry: string; exit: string; scale: string; floor: string; trunc: string }[];
    amountOut: { amountIn: string; reserveIn: string; reserveOut: string; feeBps: string; expected: string }[];
    sqrt: { x: string; expected: string }[];
  };
};
const probe = new Noir(JSON.parse(readFileSync(`${ROOT}zk/circuits/target/math_probe.json`, "utf8")) as CompiledCircuit);

const LIMIT = 1n << 96n;
const inRange = (...xs: bigint[]): boolean => xs.every((x) => x < LIMIT);
const DIVISOR_LIMIT = 1n << 112n;
const abs = (x: bigint): bigint => (x < 0n ? -x : x);

async function run(op: bigint, a: bigint, b: bigint, c: bigint, d: bigint, isShort: bigint, expected: bigint, expected2: bigint, gains: boolean): Promise<void> {
  const f = toHex32;
  await probe.execute({ op: f(op), a: f(a), b: f(b), c: f(c), d: f(d), is_short: f(isShort), expected: f(expected), expected2: f(expected2), gains });
}

describe("circuit and SDK math against the independent risk kernel", () => {
  it("the probe rejects a wrong expected value, so agreement below means something", async () => {
    const v = vectors.cases.marginRequirement.find((c) => inRange(BigInt(c.absSize), BigInt(c.price), BigInt(c.fraction)))!;
    await expect(run(0n, BigInt(v.absSize), BigInt(v.price), BigInt(v.fraction), BigInt(v.scale), 0n, BigInt(v.expected) + 1n, 0n, false)).rejects.toThrow();
  });

  it("margin requirement", async () => {
    const cases = vectors.cases.marginRequirement.map((v) => ({ size: BigInt(v.absSize), price: BigInt(v.price), frac: BigInt(v.fraction), scale: BigInt(v.scale), want: BigInt(v.expected) })).filter((v) => inRange(v.size, v.price, v.frac));
    expect(cases.length).toBeGreaterThanOrEqual(150);
    for (const v of cases) {
      expect(marginRequirement(v.size, v.price, v.frac, v.scale)).toBe(v.want);
      await run(0n, v.size, v.price, v.frac, v.scale, 0n, v.want, 0n, false);
    }
  });

  it("swap output", async () => {
    const cases = vectors.cases.amountOut.map((v) => ({ a: BigInt(v.amountIn), rIn: BigInt(v.reserveIn), rOut: BigInt(v.reserveOut), fee: BigInt(v.feeBps), want: BigInt(v.expected) })).filter((v) => inRange(v.a, v.rIn, v.rOut));
    expect(cases.length).toBeGreaterThanOrEqual(150);
    for (const v of cases) {
      expect(amountOut(v.a, v.rIn, v.rOut, v.fee)).toBe(v.want);
      await run(3n, v.a, v.rIn, v.rOut, v.fee, 0n, v.want, 0n, false);
    }
  });

  it("integer square root", async () => {
    const cases = vectors.cases.sqrt.map((v) => ({ x: BigInt(v.x), want: BigInt(v.expected) })).filter((v) => v.x < 1n << 192n);
    expect(cases.length).toBeGreaterThanOrEqual(50);
    for (const v of cases) {
      expect(floorSqrt(v.x)).toBe(v.want);
      await run(4n, v.x, 0n, 0n, 0n, 0n, v.want, 0n, false);
    }
  });

  it("fee and liquidation penalty", async () => {
    const cases = vectors.cases.fee.map((v) => ({ size: BigInt(v.absSize), price: BigInt(v.price), bps: BigInt(v.bps), scale: BigInt(v.scale), want: BigInt(v.expected) })).filter((v) => inRange(v.size, v.price));
    expect(cases.length).toBeGreaterThanOrEqual(150);
    for (const v of cases) {
      expect(positionFee(v.size, v.price, v.bps, v.scale)).toBe(v.want);
      await run(1n, v.size, v.price, v.bps, v.scale, 0n, v.want, 0n, false);
    }
  });

  it("pair PnL: both directions, floor for health, truncation for transfer", async () => {
    const WAD = 10n ** 18n;
    const cases = vectors.cases.pnl.map((v) => ({ size: BigInt(v.size), entry: BigInt(v.entry), exit: BigInt(v.exit), scale: BigInt(v.scale), floor: BigInt(v.floor), trunc: BigInt(v.trunc) })).filter((v) => inRange(abs(v.size), v.entry, v.exit) && WAD * v.scale < DIVISOR_LIMIT);
    expect(cases.length).toBeGreaterThanOrEqual(200);
    let shorts = 0;
    let losses = 0;
    for (const v of cases) {
      const isShort = v.size < 0n ? 1n : 0n;
      shorts += Number(isShort);
      const p = pairPnl(isShort, abs(v.size), v.entry, v.exit, v.scale);
      const gains = v.floor >= 0n;
      expect(p.floor).toBe(abs(v.trunc));
      if (p.floor !== 0n) expect(p.takerGains).toBe(gains);
      if (!gains) {
        losses++;
        expect(p.ceil).toBe(-v.floor);
      }
      await run(2n, abs(v.size), v.entry, v.exit, v.scale, isShort, p.floor, p.ceil, gains);
    }
    expect(shorts).toBeGreaterThan(20);
    expect(losses).toBeGreaterThan(20);
    console.log(`pnl vectors in range: ${cases.length}, shorts ${shorts}, losses ${losses}`);
  }, 120_000);
});
