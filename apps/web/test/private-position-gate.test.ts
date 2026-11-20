import { ACTOR_TAKER, FUNDING_INDEX_ZERO, updateOutcome, type PairRecord } from "@rooq/private-sdk";
import { describe, expect, it } from "vitest";
import { changeGate, type GateMarket } from "../lib/private/position-gate";

const WAD = 10n ** 18n;
const USDG = 10n ** 6n;
const UPDATED_AT = 1_000_000n;

// One TSLA long at $250 against USDG collateral (scale 1e12): initial margin 10% is 25 USDG, maintenance 5% is 12.5.
const market: GateMarket = { mark: 250n * WAD, imrWad: WAD / 10n, mmrWad: WAD / 20n, scale: 10n ** 12n, fundingIndex: FUNDING_INDEX_ZERO, takerFeeBps: 5n };

function pair(takerMargin: bigint): PairRecord {
  return {
    market: 1n, asset: 1n, isShort: 0n, size: WAD, entry: 250n * WAD, fundingIndex: FUNDING_INDEX_ZERO, closeSpread: 20n, fundingDebt: 0n, debtByTaker: 0n, lastReduce: 0n, updatedAt: UPDATED_AT,
    takerMargin, makerMargin: 1_000n * USDG, takerAuth: 1n, takerX: 1n, takerY: 1n, makerAuth: 2n, makerX: 2n, makerY: 2n, recNonce: 3n, blind: 4n,
  };
}

const gate = (p: PairRecord, now: bigint, exitMatureAt: bigint | null = null, legacy = false) => changeGate({ pair: p, side: "taker", market, now, exitMatureAt, legacy });

describe("position change gate (pair cooldown)", () => {
  it("is open once the 10 minute window has passed", () => {
    // #given a version stamped at UPDATED_AT #when ten minutes have passed #then any change may run
    expect(gate(pair(100n * USDG), UPDATED_AT + 600n)).toEqual({ state: "open" });
  });

  it("names when the next change is possible inside the window", () => {
    expect(gate(pair(100n * USDG), UPDATED_AT + 60n)).toEqual({ state: "cooldown", nextChangeAt: UPDATED_AT + 600n, cureFrom: null });
  });

  it("offers the least top-up that reaches initial margin when this side is below it", () => {
    // #given a taker with 20 USDG against a 25 USDG initial margin, inside the window
    const p = pair(20n * USDG);
    const g = gate(p, UPDATED_AT + 60n);
    if (g.state !== "cooldown" || g.cureFrom === null) throw new Error("expected a cure");
    // #then that top-up runs and one unit less doesn't
    const run = (add: bigint) => updateOutcome(p, { actor: ACTOR_TAKER, add, remove: 0n, reduce: 0n }, market.mark!, market.imrWad, market.scale, market.fundingIndex, market.takerFeeBps, { mmrWad: market.mmrWad, asOf: UPDATED_AT + 60n }).refused;
    expect([run(g.cureFrom), run(g.cureFrom - 1n)]).toEqual([null, "cure must reach initial margin"]);
  });

  it("offers no top-up while the price is stale", () => {
    expect(changeGate({ pair: pair(20n * USDG), side: "taker", market: { ...market, mark: null }, now: UPDATED_AT + 60n, exitMatureAt: null, legacy: false })).toEqual({ state: "cooldown", nextChangeAt: UPDATED_AT + 600n, cureFrom: null });
  });

  it("freezes a position whose forced exit has matured", () => {
    expect(gate(pair(100n * USDG), UPDATED_AT + 9_000n, UPDATED_AT + 8_000n)).toEqual({ state: "exit_matured" });
  });

  it("keeps a pending exit open to changes until it matures", () => {
    expect(gate(pair(100n * USDG), UPDATED_AT + 9_000n, UPDATED_AT + 10_000n)).toEqual({ state: "open" });
  });

  it("marks an old deployment's pair as unchangeable here", () => {
    expect(gate(pair(100n * USDG), UPDATED_AT + 9_000n, null, true)).toEqual({ state: "legacy" });
  });
});
