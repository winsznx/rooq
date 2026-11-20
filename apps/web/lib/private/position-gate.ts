import { ACTOR_MAKER, ACTOR_TAKER, AMOUNT_LIMIT, MIN_UPDATE_GAP, nextUpdateAt, updateOutcome, type PairRecord } from "@rooq/private-sdk";

/** Market inputs an update is checked against. `mark` is null while the feed is stale. */
export interface GateMarket {
  readonly mark: bigint | null;
  readonly imrWad: bigint;
  readonly mmrWad: bigint;
  readonly scale: bigint;
  readonly fundingIndex: bigint;
  readonly takerFeeBps: bigint;
}

/**
 * Whether the owner can change a position now. `open`: any change. `cooldown`: inside the 10 minute window after the
 * last version, where the contract takes only a top-up that brings the owner's side back to initial margin
 * (`cureFrom` is the least such top-up, null when this side isn't below initial margin). `exit_matured`: a forced
 * exit has matured, so the lineage is frozen and only the close runs. `legacy`: an old deployment's pair, which these
 * circuits can't update.
 */
export type ChangeGate =
  | { readonly state: "open" }
  | { readonly state: "cooldown"; readonly nextChangeAt: bigint; readonly cureFrom: bigint | null }
  | { readonly state: "exit_matured" }
  | { readonly state: "legacy" };

function addAccepted(p: PairRecord, actor: bigint, add: bigint, m: GateMarket & { mark: bigint }, now: bigint, minGap: bigint): boolean {
  const o = updateOutcome(p, { actor, add, remove: 0n, reduce: 0n }, m.mark, m.imrWad, m.scale, m.fundingIndex, m.takerFeeBps, { mmrWad: m.mmrWad, asOf: now, minGap });
  return o.refused === null;
}

/** Least top-up the SDK accepts right now, by doubling then bisection. Adding margin never makes a refusal more likely. */
function leastAccepted(accepts: (add: bigint) => boolean): bigint | null {
  let hi = 1n;
  while (!accepts(hi)) {
    hi *= 2n;
    if (hi >= AMOUNT_LIMIT) return null;
  }
  let lo = hi / 2n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (accepts(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function changeGate(r: {
  readonly pair: PairRecord;
  readonly side: "taker" | "maker";
  readonly market: GateMarket;
  readonly now: bigint;
  readonly exitMatureAt: bigint | null;
  readonly legacy: boolean;
  readonly minGap?: bigint;
}): ChangeGate {
  if (r.legacy) return { state: "legacy" };
  if (r.exitMatureAt !== null && r.now >= r.exitMatureAt) return { state: "exit_matured" };
  const minGap = r.minGap ?? MIN_UPDATE_GAP;
  const nextChangeAt = nextUpdateAt(r.pair, minGap);
  if (r.now >= nextChangeAt) return { state: "open" };
  const mark = r.market.mark;
  if (mark === null) return { state: "cooldown", nextChangeAt, cureFrom: null };
  const actor = r.side === "taker" ? ACTOR_TAKER : ACTOR_MAKER;
  const m = { ...r.market, mark };
  return { state: "cooldown", nextChangeAt, cureFrom: leastAccepted((add) => addAccepted(r.pair, actor, add, m, r.now, minGap)) };
}
