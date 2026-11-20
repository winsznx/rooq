import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { changePct, lastAtOrBefore, ONE_DOLLAR, PriceHistory, usdValue } from "../../src/lib/analytics-prices";
import { TokenBook } from "../../src/lib/analytics-tokens";
import { vaultReport, VaultReader, type VaultChain } from "../../src/lib/analytics-vault";
import { createLogger } from "../../src/lib/log";

const H0 = 1_800_000_000 - (1_800_000_000 % 3_600);
const USDG: Address = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
const TSLA: Address = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";
const AMZN: Address = "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02";
const FEED: Address = "0x6266a7d494fD35aEC096aBf2De04c2A814220BDf";
const POOL: Address = "0x6b3dEA9d7C3FaCbFd8Eb78c101f0C0fF45648DF5";
const log = createLogger("analytics-test");

describe("usd values", () => {
  test("respect token and feed decimals", () => {
    expect(usdValue(1_500_000n, 6, ONE_DOLLAR)).toBe(1.5);
    expect(usdValue(2n * 10n ** 18n, 18, { answer: 250_12345678n, decimals: 8 })).toBe(500.246913);
    expect(usdValue(5n, 0, { answer: 3n, decimals: 0 })).toBe(15);
  });

  test("stay exact for amounts past 2^53 base units", () => {
    expect(usdValue(123_456_789n * 10n ** 18n, 18, { answer: 10n ** 8n, decimals: 8 })).toBe(123_456_789);
  });

  test("a non-positive answer is no price", () => {
    expect(usdValue(1n, 0, { answer: 0n, decimals: 8 })).toBeNull();
    expect(usdValue(1n, 0, { answer: -5n, decimals: 8 })).toBeNull();
  });

  test("change is against the previous window, null with nothing before", () => {
    expect(changePct(150, 100)).toBe(50);
    expect(changePct(650, 64)).toBe(915.63);
    expect(changePct(10, 0)).toBeNull();
  });
});

describe("price history", () => {
  const rows = [
    { hour: H0, feed: FEED.toLowerCase(), answer: "25000000000" },
    { hour: H0 + 7_200, feed: FEED.toLowerCase(), answer: "30000000000" },
    { hour: H0, feed: "0x0000000000000000000000000000000000000001", answer: "1" },
  ];
  const history = new PriceHistory(rows, [{ asset: TSLA, feed: FEED, decimals: 8 }], USDG);

  test("uses the event's hour, else the last earlier hour, else nothing", () => {
    expect(history.priceAt(TSLA, H0 + 59)).toEqual({ answer: 25_000_000_000n, decimals: 8 });
    expect(history.priceAt(TSLA.toLowerCase(), H0 + 3_700)).toEqual({ answer: 25_000_000_000n, decimals: 8 });
    expect(history.priceAt(TSLA, H0 + 7_200 + 1)).toEqual({ answer: 30_000_000_000n, decimals: 8 });
    expect(history.priceAt(TSLA, H0 - 1)).toBeNull();
  });

  test("the stable asset is a dollar and an asset without a feed is unpriced", () => {
    expect(history.priceAt(USDG.toLowerCase(), 0)).toEqual(ONE_DOLLAR);
    expect(history.priceAt(AMZN, H0)).toBeNull();
  });

  test("binary search finds the last element at or before", () => {
    expect(lastAtOrBefore([], 5)).toBe(-1);
    expect(lastAtOrBefore([1, 3, 5], 0)).toBe(-1);
    expect(lastAtOrBefore([1, 3, 5], 3)).toBe(1);
    expect(lastAtOrBefore([1, 3, 5], 4)).toBe(1);
    expect(lastAtOrBefore([1, 3, 5], 99)).toBe(2);
  });
});

describe("vault", () => {
  test("values holdings, shares the priced total and leaves unpriced ones at zero share", () => {
    const report = vaultReport(H0, [
      { asset: USDG, amount: 300_000_000n, decimals: 6, symbol: "USDG", price: ONE_DOLLAR },
      { asset: TSLA, amount: 10n ** 18n / 2n, decimals: 18, symbol: "TSLA", price: { answer: 200_00000000n, decimals: 8 } },
      { asset: AMZN, amount: 7n, decimals: null, symbol: null, price: null },
    ]);
    expect(report.totalUsd).toBe(400);
    expect(report.assets.map((a) => [a.symbol, a.usd, a.sharePct, a.decimalsKnown])).toEqual([["USDG", 300, 75, true], ["TSLA", 100, 25, true], [AMZN, null, 0, false]]);
  });

  test("reads balances and live answers once per ttl, and a failed price read only unprices that asset", async () => {
    let balanceReads = 0;
    const chain: VaultChain = {
      balanceOf: (token, holder) => {
        balanceReads++;
        expect(holder).toBe(POOL);
        return Promise.resolve(token === USDG ? 5_000_000n : 2n * 10n ** 18n);
      },
      latestAnswer: (feed) => (feed === FEED ? Promise.resolve(100_00000000n) : Promise.reject(new Error("feed down"))),
    };
    const tokens = new TokenBook((a) => Promise.resolve(a === USDG ? { symbol: "USDG", decimals: 6 } : { symbol: a === TSLA ? "TSLA" : "AMZN", decimals: 18 }), log);
    await tokens.load([USDG, TSLA, AMZN]);
    const feeds = [{ asset: TSLA, feed: FEED, decimals: 8 }, { asset: AMZN, feed: "0x0000000000000000000000000000000000000002", decimals: 8 }];
    const reader = new VaultReader(chain, POOL, USDG, () => [USDG, TSLA, AMZN, TSLA.toLowerCase() as Address], () => feeds, tokens, 60_000, log);
    const first = await reader.snapshot(0);
    expect(first.totalUsd).toBe(205);
    expect(first.assets.find((a) => a.symbol === "AMZN")).toMatchObject({ usd: null, sharePct: 0, amount: (2n * 10n ** 18n).toString() });
    await reader.snapshot(1_000);
    expect(balanceReads).toBe(3);
  });
});
