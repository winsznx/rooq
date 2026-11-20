import { describe, expect, test } from "bun:test";
import type { Point } from "@rooq/private-sdk";
import { countAfter, currentKeySince, retiredDeltas, retiredUnspent, SINCE_DEPLOYMENT, type KeyRotationEvent } from "../../src/lib/key-health";

const p = (n: bigint): Point => ({ x: n, y: n + 1n });
const genesis = { coordinator: p(1n), riskA: p(2n), riskB: p(3n) };
const rotation = (block: bigint, keys: Partial<typeof genesis>): KeyRotationEvent => ({ epoch: block, block, keys: { ...genesis, ...keys } });

describe("retired-key bookkeeping", () => {
  test("#32: an expired but unspent lock on the old key still counts", () => {
    const now = 1_000n;
    const locks = [{ keyIndex: 1, expiry: now - 10n, spent: false }, { keyIndex: 1, expiry: now - 10n, spent: true }, { keyIndex: 0, expiry: now + 10n, spent: false }];
    expect(retiredUnspent(locks, 0, (l) => l.spent)).toBe(1);
  });

  test("#30: a queued pair on the old key counts, wherever it sits", () => {
    const pairs = [{ keyIndex: 1, leafIndex: 900, spent: false }];
    expect(retiredUnspent(pairs, 0, (x) => x.spent)).toBe(1);
  });

  test("#30: an unfolded delta that only a spent retired-key pair opens counts", () => {
    const sources = new Map([
      [10n, { opening: "liquidation", keyIndices: [0, 1] }],
      [11n, { opening: "open", keyIndices: [0] }],
      [12n, { opening: "close", keyIndices: [1] }],
    ]);
    expect(retiredDeltas([10n, 11n, 12n, 13n], sources, 0)).toBe(2);
    expect(retiredDeltas([], sources, 0)).toBe(0);
  });

  test("#31: records from before the current key took effect are not unreadable", () => {
    const rotations = [rotation(500n, { riskA: p(20n) })];
    expect(currentKeySince(genesis, rotations, "riskA", p(20n))).toBe(500n);
    expect(countAfter([10n, 200n, 499n, 500n], 500n)).toBe(0);
    expect(countAfter([10n, 200n, 500n, 501n, 900n], 500n)).toBe(2);
  });

  test("#31: a slot a rotation left alone keeps its genesis boundary", () => {
    const rotations = [rotation(500n, { coordinator: p(10n) })];
    expect(currentKeySince(genesis, rotations, "riskA", p(2n))).toBe(SINCE_DEPLOYMENT);
    expect(countAfter([0n, 5n], SINCE_DEPLOYMENT)).toBe(2);
  });

  test("#31: the boundary is the rotation that brought the current key in, not a later one that kept it", () => {
    const rotations = [rotation(500n, { riskA: p(20n) }), rotation(800n, { riskA: p(20n), coordinator: p(10n) })];
    expect(currentKeySince(genesis, rotations, "riskA", p(20n))).toBe(500n);
    expect(currentKeySince(genesis, rotations, "coordinator", p(10n))).toBe(800n);
  });

  test("#31: a key the ledger hasn't seen activated yet counts every record", () => {
    expect(currentKeySince(genesis, [], "riskB", p(99n))).toBe(SINCE_DEPLOYMENT);
  });
});
