import { describe, expect, it } from "vitest";
import type { AdminActionSeries, AdminVault } from "@rooq/private-sdk/admin";
import { ethUnits, sharePct, signedPct, tokenUnits, usd, usdPrice } from "../components/admin/format";
import { bpsLabel, splitPct, topKinds, vaultSlices } from "../components/admin/slices";

const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F" as const;
const TSLA = "0x00000000000000000000000000000000000000a1" as const;
const AAPL = "0x00000000000000000000000000000000000000a2" as const;
const NVDA = "0x00000000000000000000000000000000000000a3" as const;
const AMZN = "0x00000000000000000000000000000000000000a4" as const;

describe("dollar and unit formatting", () => {
  it("spells out a hero figure to the dollar and compacts a tile", () => {
    expect(usd(1_240_512.4, { whole: true })).toBe("$1,240,512");
    expect(usd(1_240_512.4)).toBe("$1.24M");
    expect(usd(12.5)).toBe("$12.50");
    expect(usd(-3)).toBe("−$3.00");
    expect(usd(null)).toBe("—");
  });
  it("keeps four significant digits on a small token price", () => {
    expect(usdPrice(0.000012345)).toBe("$0.00001235");
    expect(usdPrice(2.5)).toBe("$2.50");
  });
  it("reads ETH and token amounts that arrive in whole units", () => {
    expect(ethUnits(1.23456789)).toBe("1.2346 ETH");
    expect(tokenUnits(1_500_000, "ROOQ")).toBe("1.50M ROOQ");
  });
  it("signs a change and floors a sliver of a share", () => {
    expect(signedPct(12.34)).toBe("+12.3%");
    expect(signedPct(-4)).toBe("−4.0%");
    expect(signedPct(null)).toBe("—");
    expect(sharePct(0.04)).toBe("<0.1%");
    expect(sharePct(62.5)).toBe("62.5%");
  });
  it("reads a basis-point rate as a percentage", () => {
    expect(bpsLabel(70)).toBe("0.7%");
    expect(bpsLabel(125)).toBe("1.25%");
  });
});

describe("transactions by kind", () => {
  const kind = (action: string, values: number[]): AdminActionSeries => ({ action, category: "user", series: values.map((v, i) => ({ t: i * 3600, v })) });

  it("keeps the busiest kinds and folds the rest into one layer", () => {
    const layers = topKinds([kind("shield", [5, 5]), kind("unshield", [1, 1]), kind("openPair", [3, 3]), kind("swap", [2, 0]), kind("addLiquidity", [0, 1]), kind("idle", [0, 0])], 3);
    expect(layers.map((l) => l.id)).toEqual(["shield", "openPair", "unshield", "other"]);
    expect(layers[3]!.label).toBe("2 other kinds");
    expect(layers[3]!.points).toEqual([
      { t: 0, v: 2 },
      { t: 3600, v: 1 },
    ]);
  });
  it("names a single leftover kind instead of calling it other", () => {
    expect(topKinds([kind("shield", [2]), kind("unshield", [1])], 1).map((l) => l.label)).toEqual(["Shield", "Unshield"]);
  });
});

describe("vault donut", () => {
  const holding = (asset: `0x${string}`, symbol: string, usdValue: number | null, pct: number) => ({ asset, symbol, decimals: 18, decimalsKnown: true, amount: "1", usd: usdValue, sharePct: pct });
  const vault: AdminVault = {
    asOf: 0,
    totalUsd: 1000,
    assets: [holding(USDG, "USDG", 600, 60), holding(TSLA, "TSLA", 200, 20), holding(AAPL, "AAPL", 100, 10), holding(NVDA, "NVDA", 60, 6), holding(AMZN, "AMZN", 40, 4), holding(USDG.replace("7E", "7F") as `0x${string}`, "X", null, 0)],
  };

  it("draws the three largest holdings and one other slice, leaving unpriced assets out", () => {
    const slices = vaultSlices(vault, 3);
    expect(slices.map((s) => s.label)).toEqual(["USDG", "TSLA", "AAPL", "2 others"]);
    expect(slices[3]).toMatchObject({ id: "other", pct: 10, usd: 100 });
  });
});

describe("split bar", () => {
  it("returns shares of the sum and nothing for an empty split", () => {
    expect(splitPct(3, 1)).toEqual([75, 25]);
    expect(splitPct(0, 0)).toEqual([0, 0]);
  });
});
