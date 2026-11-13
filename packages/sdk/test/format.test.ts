import { describe, expect, it } from "vitest";
import { UNKNOWN, formatCollateral, formatCompact, formatFixed, formatPercentWad, formatPrice } from "../src/format";
import { parseDecimal as parse, toDecimalInput } from "../src/units";

describe("formatting never invents values", () => {
  it("unknown renders as an em dash, not zero", () => {
    expect(formatFixed(null, 6, 2)).toBe(UNKNOWN);
    expect(formatCollateral(undefined, 6, "USDG")).toBe(UNKNOWN);
  });
  it("uses a true minus and explicit plus", () => {
    expect(formatFixed(-1_234_500n, 6, 2)).toBe("−1.23");
    expect(formatFixed(1_235_000n, 6, 2, { sign: "always" })).toBe("+1.24");
    expect(formatFixed(0n, 6, 2, { sign: "always" })).toBe("0.00");
  });
  it("suffixes collateral and never prefixes a dollar sign", () => {
    expect(formatCollateral(12_345_678_900n, 6, "USDG")).toBe("12,345.68 USDG");
  });
  it("compacts with uppercase suffix", () => {
    expect(formatCompact(530_060_000n * 10n ** 6n, 6)).toBe("530.06M");
  });
  it("formats prices and signed percentages", () => {
    expect(formatPrice(359_450_000_000_000_000_000n)).toBe("359.45");
    expect(formatPercentWad(12_300_000_000_000_000n)).toBe("+1.23%");
  });
  it("parses decimals without floating point", () => {
    expect(parse("1,000.50", 6)).toBe(1_000_500_000n);
    expect(parse("0.0000001", 6)).toBeNull();
    expect(parse("abc", 6)).toBeNull();
  });
});

describe("parseDecimal commas", () => {
  it("accepts commas only as thousands groups", () => {
    expect(parse("1,250.5", 6)).toBe(1_250_500_000n);
    expect(parse("12,000", 2)).toBe(1_200_000n);
  });

  it("rejects a decimal comma instead of reading 1,5 as 15", () => {
    expect(parse("1,5", 6)).toBeNull();
    expect(parse("1,50", 6)).toBeNull();
    expect(parse("1,2,3", 6)).toBeNull();
    expect(parse(",5", 6)).toBeNull();
  });
});

describe("toDecimalInput", () => {
  it("keeps every digit and drops only trailing zeros", () => {
    expect(toDecimalInput(95_830_000_000_000_000n, 18)).toBe("0.09583");
    expect(toDecimalInput(2_500_314_700n, 6)).toBe("2500.3147");
    expect(toDecimalInput(1n, 18)).toBe("0.000000000000000001");
    expect(toDecimalInput(100_000_000n, 6)).toBe("100");
    expect(toDecimalInput(0n, 6)).toBe("0");
  });

  it("round-trips through parseDecimal", () => {
    for (const v of [0n, 1n, 123_456_789n, 10n ** 24n + 7n]) expect(parse(toDecimalInput(v, 18), 18)).toBe(v);
  });
});
