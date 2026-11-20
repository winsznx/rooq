import { describe, expect, it } from "vitest";
import { assetAmount } from "../components/admin/format";

const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F" as const;

describe("asset amounts", () => {
  it("scales by the token's decimals once they are known", () => {
    expect(assetAmount({ asset: USDG, symbol: "USDG", decimals: 6, decimalsKnown: true, amount: "5000000" })).toBe("5.00 USDG");
  });
  it("labels raw base units instead of scaling them by a guessed 0 decimals", () => {
    expect(assetAmount({ asset: USDG, symbol: USDG, decimals: 0, decimalsKnown: false, amount: "5000000" })).toMatch(/^5(\.0+)?M base units of 0x7E95/);
  });
});
