import { describe, expect, test } from "bun:test";
import { fixedJitterBps, jitteredAnswer, parseFixedFeeds } from "../../src/lib/fixed-price";

const FEED = `0x${"ab".repeat(32)}` as const;
const OTHER = `0x${"cd".repeat(32)}` as const;
const WIDE = { min8: 1n, max8: 10n ** 20n };

describe("RELAY_FIXED_FEEDS", () => {
  test("empty or unset means no fixed feeds", () => {
    expect(parseFixedFeeds(undefined).size).toBe(0);
    expect(parseFixedFeeds(" ").size).toBe(0);
  });

  test("parses feed, label and an 8-decimal price", () => {
    const feeds = parseFixedFeeds(`${FEED.toUpperCase().replace("0X", "0x")}:QHT:1.25, ${OTHER}:B:3`);
    expect(feeds.get(FEED)).toEqual({ feedId: FEED, label: "QHT", reference8: 125_000_000n });
    expect(feeds.get(OTHER)?.reference8).toBe(300_000_000n);
  });

  test("rejects malformed, zero and duplicate entries", () => {
    expect(() => parseFixedFeeds(`${FEED}:QHT`)).toThrow();
    expect(() => parseFixedFeeds(`0x1234:QHT:1`)).toThrow();
    expect(() => parseFixedFeeds(`${FEED}:QHT:1.123456789`)).toThrow();
    expect(() => parseFixedFeeds(`${FEED}:QHT:0`)).toThrow();
    expect(() => parseFixedFeeds(`${FEED}:A:1,${FEED}:B:2`)).toThrow();
  });

  test("jitter defaults to 20 bps and is capped", () => {
    expect(fixedJitterBps({})).toBe(20n);
    expect(fixedJitterBps({ RELAY_FIXED_JITTER_BPS: "0" })).toBe(0n);
    expect(() => fixedJitterBps({ RELAY_FIXED_JITTER_BPS: "1000" })).toThrow();
  });
});

describe("jittered answer", () => {
  const ref = 100_000_000n;

  test("spans exactly +/- jitter around the reference", () => {
    expect(jitteredAnswer(ref, 20n, WIDE, () => 0)).toBe(99_800_000n);
    expect(jitteredAnswer(ref, 20n, WIDE, () => 0.999999)).toBe(100_200_000n);
    expect(jitteredAnswer(ref, 20n, WIDE, () => 0.5)).toBe(ref);
    expect(jitteredAnswer(ref, 0n, WIDE, () => 0.7)).toBe(ref);
  });

  test("stays inside the feed bounds", () => {
    expect(jitteredAnswer(ref, 20n, { min8: ref, max8: ref * 2n }, () => 0)).toBe(ref);
    expect(jitteredAnswer(ref, 20n, { min8: 1n, max8: ref }, () => 0.99)).toBe(ref);
  });

  test("random draws never leave the band", () => {
    for (let i = 0; i < 500; i++) {
      const a = jitteredAnswer(ref, 20n, WIDE);
      expect(a >= 99_800_000n && a <= 100_200_000n).toBe(true);
    }
  });
});
