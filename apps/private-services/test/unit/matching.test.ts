import { describe, expect, test } from "bun:test";
import { ROLE_MAKER, ROLE_TAKER, type LockRecord } from "@rooq/private-sdk";
import type { MarketInfo } from "../../src/lib/chain";
import { closeSpreadAboveCap, makerOrder, matchTakers, type MarketInputs, type Matcher, type MatchLimits, type MatchLock } from "../../src/lib/matching";

const NOW = 1_000_000n;
const MARKET: MarketInfo = {
  id: 1n, asset: `0x${"11".repeat(20)}`, feedId: `0x${"22".repeat(32)}`, scale: 1n, imrWad: 0n, mmrWad: 0n, penaltyBps: 0n, maxFundingPerHourWad: 0n, takerFeeBps: 0n, maxOiUsdWad: 0n, maxPairSize: 0n, maxCloseSpreadBps: 50n,
};
const LIMITS: MatchLimits = { maxPlans: 20_000, maxOpens: 8, maxLockLifetime: 7n * 86_400n };

function lock(leafIndex: number, role: bigint, over: Partial<LockRecord> = {}): MatchLock {
  return {
    leafIndex,
    record: { asset: 1n, amount: 1_000n, ownerAuth: 0n, ownerX: 0n, ownerY: 0n, role, market: MARKET.id, t2: 0n, t3: 1n, t4: 0n, expiry: NOW + 3_600n, recNonce: BigInt(leafIndex), blind: 0n, ...over },
  };
}

interface Counters {
  inputs: number;
  plans: number;
  opens: number;
}

/** Takers with t4 === 0n can never fill, as an unreachable limit price would. */
function matcher(counters: Counters, market: MarketInfo = MARKET): Matcher<MatchLock> {
  const inputs: MarketInputs = {
    closeOnly: false, funding: { index: 0n, lastEpoch: NOW, head: 0n, consumed: 0n, bondUsed: 0n }, pendingOpens: 0n, price: { price: 100n, updatedAt: NOW, fresh: true },
    state: { longOi: 0n, shortOi: 0n, insurance: 0n, badDebt: 0n, bondUsed: 0n, blind: 0n },
  };
  return {
    market: (id) => (id === market.id ? market : undefined),
    inputs: () => {
      counters.inputs++;
      return Promise.resolve(inputs);
    },
    plan: (_m, t) => {
      counters.plans++;
      return t.t4 === 0n ? { kind: "skip", reason: "PRICE_OUTSIDE_LIMIT" } : { kind: "ok" };
    },
    open: () => {
      counters.opens++;
      return Promise.resolve({ matched: true, reason: null });
    },
    blocked: () => false,
    onProofRefused: () => undefined,
  };
}

describe("coordinator matching (audit #14)", () => {
  test("market reads happen once per round, not once per taker-maker pair", async () => {
    const counters: Counters = { inputs: 0, plans: 0, opens: 0 };
    const spam = Array.from({ length: 1_000 }, (_, i) => lock(i, ROLE_TAKER, { expiry: NOW + 3_600n }));
    const real = lock(5_000, ROLE_TAKER, { t4: 200n });
    const makers = [lock(10_000, ROLE_MAKER, { t2: 5n }), lock(10_001, ROLE_MAKER, { t2: 10n }), lock(10_002, ROLE_MAKER, { t2: 20n })];
    const round = await matchTakers([...spam, real], makers, NOW, matcher(counters), LIMITS);
    expect(counters.inputs).toBe(1);
    expect(round.matched).toBe(1);
    expect(round.skips.PRICE_OUTSIDE_LIMIT).toBe(1_000);
  });

  test("a taker whose limit refuses the tightest maker is not checked against the rest", async () => {
    const counters: Counters = { inputs: 0, plans: 0, opens: 0 };
    const makers = Array.from({ length: 50 }, (_, i) => lock(100 + i, ROLE_MAKER, { t2: BigInt(i) }));
    await matchTakers([lock(1, ROLE_TAKER)], makers, NOW, matcher(counters), LIMITS);
    expect(counters.plans).toBe(1);
  });

  test("a fill re-reads that market for the next taker", async () => {
    const counters: Counters = { inputs: 0, plans: 0, opens: 0 };
    const takers = [lock(1, ROLE_TAKER, { t4: 200n }), lock(2, ROLE_TAKER, { t4: 200n })];
    const makers = [lock(10, ROLE_MAKER), lock(11, ROLE_MAKER)];
    const round = await matchTakers(takers, makers, NOW, matcher(counters), LIMITS);
    expect(round.matched).toBe(2);
    expect(counters.inputs).toBe(2);
  });

  test("locks that outlive the configured lifetime are skipped", async () => {
    const counters: Counters = { inputs: 0, plans: 0, opens: 0 };
    const round = await matchTakers([lock(1, ROLE_TAKER, { t4: 200n, expiry: NOW + 10n * 365n * 86_400n })], [lock(10, ROLE_MAKER)], NOW, matcher(counters), LIMITS);
    expect(round.matched).toBe(0);
    expect(round.skips.LOCK_LIFETIME_TOO_LONG).toBe(1);
    expect(counters.inputs).toBe(0);
  });

  test("plan and proof caps bound one round", async () => {
    const counters: Counters = { inputs: 0, plans: 0, opens: 0 };
    const takers = Array.from({ length: 20 }, (_, i) => lock(i, ROLE_TAKER, { t4: 200n }));
    const makers = Array.from({ length: 20 }, (_, i) => lock(100 + i, ROLE_MAKER));
    const round = await matchTakers(takers, makers, NOW, matcher(counters), { ...LIMITS, maxOpens: 3 });
    expect(counters.opens).toBe(3);
    expect(round.skips.ROUND_WORK_CAP).toBe(17);

    const planned: Counters = { inputs: 0, plans: 0, opens: 0 };
    await matchTakers(Array.from({ length: 100 }, (_, i) => lock(i, ROLE_TAKER)), makers, NOW, matcher(planned), { ...LIMITS, maxPlans: 10 });
    expect(planned.plans).toBe(10);
  });
});

describe("maker choice (spec-pairs #9)", () => {
  test("a maker above its market's close-spread cap can never be filled; at the cap it can", () => {
    expect(closeSpreadAboveCap(MARKET, lock(1, ROLE_MAKER, { t4: 51n }).record)).toBe(true);
    expect(closeSpreadAboveCap(MARKET, lock(1, ROLE_MAKER, { t4: 50n }).record)).toBe(false);
    expect(closeSpreadAboveCap(undefined, lock(1, ROLE_MAKER, { t4: 0n }).record)).toBe(true);
  });

  test("makers sort by open spread, then close spread, then chain order", () => {
    const makers = [
      lock(1, ROLE_MAKER, { t2: 20n, t4: 40n }), lock(2, ROLE_MAKER, { t2: 10n, t4: 40n }), lock(3, ROLE_MAKER, { t2: 20n, t4: 10n }), lock(4, ROLE_MAKER, { t2: 20n, t4: 10n }),
    ];
    expect([...makers].sort(makerOrder).map((m) => m.leafIndex)).toEqual([2, 3, 4, 1]);
  });
});
