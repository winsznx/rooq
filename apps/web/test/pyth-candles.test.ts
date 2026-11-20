import { describe, expect, it } from "vitest";
import { isCandleResolution, isSessionClosed, parseUdfHistory, pythSymbolFor } from "../lib/pyth/candles";

describe("parseUdfHistory", () => {
  it("turns aligned UDF arrays into sorted candles", () => {
    // #given an ok body with two candles out of order
    const body = { s: "ok", t: [120, 60], o: [2, 1], h: [3, 2], l: [1, 0.5], c: [2.5, 1.5] };
    // #when it is parsed
    const candles = parseUdfHistory(body);
    // #then the candles come back oldest first
    expect(candles.map((c) => c.time)).toEqual([60, 120]);
  });

  it("treats no_data as an empty range", () => {
    expect(parseUdfHistory({ s: "no_data" })).toEqual([]);
  });

  it("rejects an error status", () => {
    expect(() => parseUdfHistory({ s: "error" })).toThrow("status error");
  });

  it("rejects a body that is not UDF history", () => {
    expect(() => parseUdfHistory({ candles: [] })).toThrow("unexpected shape");
  });

  it("drops rows with non-finite values", () => {
    const body = { s: "ok", t: [60, 120], o: [1, Number.NaN], h: [2, 2], l: [0.5, 1], c: [1.5, 1] };
    expect(parseUdfHistory(body)).toHaveLength(1);
  });
});

describe("isSessionClosed", () => {
  const candle = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1 });

  it("is closed when the newest 5m candle is more than three candles old", () => {
    expect(isSessionClosed([candle(0)], "5", 901)).toBe(true);
  });

  it("is open when the newest candle is recent", () => {
    expect(isSessionClosed([candle(0)], "5", 600)).toBe(false);
  });

  it("never marks daily candles closed", () => {
    expect(isSessionClosed([candle(0)], "D", 10_000_000)).toBe(false);
  });
});

describe("symbols and resolutions", () => {
  it("maps listed tickers to Pyth equity feeds", () => {
    expect(pythSymbolFor("TSLA")).toBe("Equity.US.TSLA/USD");
  });

  it("returns null for markets without a feed", () => {
    expect(pythSymbolFor("ETH")).toBeNull();
  });

  it("accepts only the supported resolutions", () => {
    expect([isCandleResolution("5"), isCandleResolution("240"), isCandleResolution(null)]).toEqual([true, false, false]);
  });
});
