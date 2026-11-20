import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { allowanceLimits, frontedBonds, RelayAllowance, retryLimitReached } from "../../src/lib/relay-allowance";

const limits = { perHour: 5, perActionPerHour: 3, perClientPerHour: 2, maxFrontedBonds: 2, maxRevertedAttempts: 2 };

describe("relayer gas allowance (audit #12)", () => {
  test("unpaid relays from one client stop at the per-client cap", () => {
    const a = new RelayAllowance(limits);
    expect(a.charge("setLiquidityRequest", "1.1.1.1", 0)).toBeNull();
    expect(a.charge("setLiquidityRequest", "1.1.1.1", 1)).toBeNull();
    expect(a.charge("setLiquidityRequest", "1.1.1.1", 2)).toBe("CLIENT");
  });

  test("many clients looping one action stop at the per-action cap", () => {
    const a = new RelayAllowance(limits);
    const results = ["a", "b", "c", "d"].map((c, i) => a.charge("lock", c, i));
    expect(results).toEqual([null, null, null, "ACTION"]);
    expect(a.charge("release", "e", 5)).toBeNull();
  });

  test("the total cap bounds gas across every action", () => {
    const a = new RelayAllowance(limits);
    const actions = ["lock", "release", "swap", "updatePair", "closePair", "redeemClaim"] as const;
    const results = actions.map((action, i) => a.charge(action, `client-${i}`, i));
    expect(results.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(results[5]).toBe("ALL");
  });

  test("the allowance comes back after an hour", () => {
    const a = new RelayAllowance(limits);
    a.charge("lock", "x", 0);
    a.charge("lock", "x", 1);
    expect(a.charge("lock", "x", 2)).toBe("CLIENT");
    expect(a.charge("lock", "x", 3_600_001)).toBeNull();
  });

  test("a refused charge uses none of the other allowances", () => {
    const a = new RelayAllowance(limits);
    a.charge("lock", "x", 0);
    a.charge("lock", "x", 1);
    for (let i = 0; i < 10; i++) a.charge("lock", "x", 2 + i);
    expect(a.charge("lock", "y", 20)).toBeNull();
  });

  test("an LP add charges both units at once, so a refusal charges nothing (re-audit)", () => {
    const a = new RelayAllowance({ perHour: 1000, perActionPerHour: 1000, perClientPerHour: 3, maxFrontedBonds: 4, maxRevertedAttempts: 3 });
    expect(a.charge("lock", "c", 0, 2)).toBeNull();
    expect(a.charge("lock", "c", 1, 2)).toBe("CLIENT");
    expect(a.charge("spend", "c", 2)).toBeNull();
    expect(a.charge("spend", "c", 3)).toBe("CLIENT");
  });

  test("a refunded charge gives every limit its units back", () => {
    const a = new RelayAllowance({ perHour: 2, perActionPerHour: 2, perClientPerHour: 2, maxFrontedBonds: 4, maxRevertedAttempts: 3 });
    expect(a.charge("lock", "c", 0, 2)).toBeNull();
    expect(a.charge("lock", "d", 1)).toBe("ALL");
    a.refund("lock", "c", 2);
    expect(a.charge("lock", "c", 2, 2)).toBeNull();
  });

  test("fronted exit bonds count only open pairs of this relayer", () => {
    const me: Address = "0x00000000000000000000000000000000000000Aa";
    const other: Address = "0x00000000000000000000000000000000000000bb";
    const nf = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
    const exits = [{ requester: me, nullifier: nf(1) }, { requester: me, nullifier: nf(2) }, { requester: other, nullifier: nf(3) }];
    expect(frontedBonds(exits, "0x00000000000000000000000000000000000000AA", (n) => n === nf(2))).toBe(1);
  });

  test("a request that keeps reverting on chain is refused after the cap", () => {
    expect(retryLimitReached(undefined, 2)).toBe(false);
    expect(retryLimitReached({ status: "reverted", attempts: 1 }, 2)).toBe(false);
    expect(retryLimitReached({ status: "reverted", attempts: 2 }, 2)).toBe(true);
    expect(retryLimitReached({ status: "reorged", attempts: 5 }, 2)).toBe(false);
  });

  test("defaults are bounded and env overrides them", () => {
    expect(allowanceLimits({})).toEqual({ perHour: 600, perActionPerHour: 240, perClientPerHour: 60, maxFrontedBonds: 4, maxRevertedAttempts: 3 });
    expect(allowanceLimits({ RELAYER_MAX_FRONTED_BONDS: "0" }).maxFrontedBonds).toBe(0);
  });
});
