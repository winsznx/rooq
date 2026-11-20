import { describe, expect, test } from "bun:test";
import { PriceGuard, priceGuardLimits } from "../../src/lib/price-guard";

const limits = priceGuardLimits({});
const bounds = { min8: 1n * 10n ** 8n, max8: 100_000n * 10n ** 8n };
const usd = (x: number): bigint => BigInt(Math.round(x * 100)) * 10n ** 6n;
const quote = (bid: number, ask: number, answer = (bid + ask) / 2): { bid8: bigint; ask8: bigint; answer8: bigint } => ({ bid8: usd(bid), ask8: usd(ask), answer8: usd(answer) });

describe("price relay guard (audit #16)", () => {
  test("a normal quote near the last answer is written", () => {
    expect(new PriceGuard(limits).check("TSLA", quote(399.9, 400.1), usd(399), bounds)).toBeNull();
  });

  test("a wide pre-market spread is refused", () => {
    expect(new PriceGuard(limits).check("TSLA", quote(1, 900), usd(400), bounds)).toBe("WIDE_SPREAD");
  });

  test("a crossed, zero or out-of-range quote is never written", () => {
    const guard = new PriceGuard(limits);
    expect(guard.check("TSLA", quote(401, 400), usd(400), bounds)).toBe("CROSSED_OR_ZERO");
    expect(guard.check("TSLA", quote(0, 0), usd(400), bounds)).toBe("CROSSED_OR_ZERO");
    expect(guard.check("TSLA", quote(0.5, 0.5), 0n, bounds)).toBe("OUT_OF_BOUNDS");
  });

  test("a jump past the bound waits for the next poll to agree", () => {
    const guard = new PriceGuard(limits);
    const wrongSplit = quote(3_999, 4_001);
    expect(guard.check("TSLA", wrongSplit, usd(400), bounds)).toBe("JUMP_UNCONFIRMED");
    expect(guard.check("TSLA", quote(4_000, 4_002), usd(400), bounds)).toBeNull();
  });

  test("a one-off bad print is never written", () => {
    const guard = new PriceGuard(limits);
    expect(guard.check("TSLA", quote(3_999, 4_001), usd(400), bounds)).toBe("JUMP_UNCONFIRMED");
    expect(guard.check("TSLA", quote(399.9, 400.1), usd(400), bounds)).toBeNull();
    expect(guard.check("TSLA", quote(3_999, 4_001), usd(400), bounds)).toBe("JUMP_UNCONFIRMED");
  });

  test("a second jump to a different price starts over", () => {
    const guard = new PriceGuard(limits);
    expect(guard.check("TSLA", quote(599.9, 600.1), usd(400), bounds)).toBe("JUMP_UNCONFIRMED");
    expect(guard.check("TSLA", quote(799.9, 800.1), usd(400), bounds)).toBe("JUMP_UNCONFIRMED");
    expect(guard.check("TSLA", quote(800, 800.2), usd(400), bounds)).toBeNull();
  });

  test("feeds are tracked separately", () => {
    const guard = new PriceGuard(limits);
    expect(guard.check("TSLA", quote(599.9, 600.1), usd(400), bounds)).toBe("JUMP_UNCONFIRMED");
    expect(guard.check("AMZN", quote(599.9, 600.1), usd(400), bounds)).toBe("JUMP_UNCONFIRMED");
  });
});
