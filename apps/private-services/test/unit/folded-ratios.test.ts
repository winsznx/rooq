import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { FoldedRatios } from "../../src/lib/folded-ratios";

const d = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

describe("/v1/claims/ratio reads (audit #13)", () => {
  test("repeat asks are served from cache and duplicates share one read", async () => {
    let reads = 0;
    const folded = new FoldedRatios((delta) => {
      reads++;
      return Promise.resolve(delta === d(1) ? 10n ** 18n + 1n : 0n);
    }, { foldedTtlMs: 600_000, unfoldedTtlMs: 15_000, maxEntries: 100, concurrency: 4 });
    expect(await folded.ratios([d(1), d(2), d(1)])).toEqual([10n ** 18n, null, 10n ** 18n]);
    expect(reads).toBe(2);
    for (let i = 0; i < 100; i++) await folded.ratios([d(1), d(2)]);
    expect(reads).toBe(2);
  });

  test("never has more than `concurrency` reads in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const folded = new FoldedRatios(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(1);
      inFlight--;
      return 0n;
    }, { foldedTtlMs: 1, unfoldedTtlMs: 1, maxEntries: 1_000, concurrency: 4 });
    await folded.ratios(Array.from({ length: 32 }, (_, i) => d(i)));
    expect(peak).toBe(4);
  });

  test("an unfolded answer is read again once its short cache lapses", async () => {
    let now = 0;
    let reads = 0;
    const folded = new FoldedRatios(() => {
      reads++;
      return Promise.resolve(0n);
    }, { foldedTtlMs: 600_000, unfoldedTtlMs: 15_000, maxEntries: 100, concurrency: 4, now: () => now });
    await folded.ratios([d(1)]);
    now = 14_000;
    await folded.ratios([d(1)]);
    now = 16_000;
    await folded.ratios([d(1)]);
    expect(reads).toBe(2);
  });

  test("the cache is bounded", async () => {
    let reads = 0;
    const folded = new FoldedRatios(() => {
      reads++;
      return Promise.resolve(2n);
    }, { foldedTtlMs: 600_000, unfoldedTtlMs: 15_000, maxEntries: 3, concurrency: 4 });
    await folded.ratios([d(1), d(2), d(3), d(4)]);
    await folded.ratios([d(1)]);
    expect(reads).toBe(5);
  });
});
