import type { LockRecord, MarketState } from "@rooq/private-sdk";
import type { FundingState, MarketInfo, PriceRead } from "./chain";

/** Everything a fill check reads from the chain for one market. None of it depends on the taker or the maker. */
export interface MarketInputs {
  readonly closeOnly: boolean;
  readonly funding: FundingState;
  /** Opens not yet folded; open_pair counts each at the market's maximum pair size. */
  readonly pendingOpens: bigint;
  readonly price: PriceRead;
  /** Null when no held key opens the market's latest record. */
  readonly state: MarketState | null;
}

/** A maker above the cap fails open_pair's `max_close_spread` check, and an unknown market can't be filled at all. */
export function closeSpreadAboveCap(m: MarketInfo | undefined, maker: LockRecord): boolean {
  return m === undefined || maker.t4 > m.maxCloseSpreadBps;
}

/** RFQ-02: tightest open spread, then tightest close spread, so a cheaper exit wins a tie, then chain order. */
export function makerOrder(a: MatchLock, b: MatchLock): number {
  if (a.record.t2 !== b.record.t2) return a.record.t2 < b.record.t2 ? -1 : 1;
  if (a.record.t4 !== b.record.t4) return a.record.t4 < b.record.t4 ? -1 : 1;
  return a.leafIndex - b.leafIndex;
}

/** Inputs for a market whose state this service can read. */
export type ReadyInputs = MarketInputs & { readonly state: MarketState };

export type MatchPlan = { kind: "ok" } | { kind: "skip"; reason: string };

export interface MatchResult {
  readonly matched: boolean;
  readonly reason: string | null;
}

export interface MatchLock {
  readonly record: LockRecord;
  readonly leafIndex: number;
}

export interface Matcher<L extends MatchLock> {
  market(id: bigint): MarketInfo | undefined;
  /** Chain reads for one market; called at most once per market per round, and again only after a fill there. */
  inputs(m: MarketInfo): Promise<MarketInputs>;
  /** Pure: mirrors the circuit's constraints so a proof is only attempted for a fill that can succeed. */
  plan(m: MarketInfo, taker: LockRecord, maker: LockRecord, inputs: ReadyInputs): MatchPlan;
  open(m: MarketInfo, taker: L, maker: L): Promise<MatchResult>;
  blocked(taker: L): boolean;
  onProofRefused(taker: L): void;
}

export interface MatchLimits {
  /** Fill checks per round; past it the remaining takers wait for the next round. */
  readonly maxPlans: number;
  /** Proof attempts per round. */
  readonly maxOpens: number;
  /** A taker whose lock outlives this many seconds is not matched. 0n turns the check off. */
  readonly maxLockLifetime: bigint;
}

export interface MatchRound {
  readonly matched: number;
  readonly usedMakers: ReadonlySet<number>;
  readonly skips: Record<string, number>;
  readonly plans: number;
}

/**
 * RFQ-02: takers in chain order; for each, the tightest maker spread, then chain order. Makers arrive sorted by spread, so
 * once a taker's limit refuses the tightest eligible maker it refuses all of them and the taker is done for the round.
 * Market reads are shared by every pair in the market, so a round costs one set of reads per active market rather than per
 * pair, and the plan and proof caps bound a round no matter how many locks are open.
 */
export async function matchTakers<L extends MatchLock>(takers: readonly L[], makers: readonly L[], now: bigint, matcher: Matcher<L>, limits: MatchLimits): Promise<MatchRound> {
  const cache = new Map<bigint, Promise<MarketInputs>>();
  const load = (m: MarketInfo): Promise<MarketInputs> => {
    let p = cache.get(m.id);
    if (!p) {
      p = matcher.inputs(m);
      cache.set(m.id, p);
    }
    return p;
  };
  const skips: Record<string, number> = {};
  const skip = (reason: string): void => {
    skips[reason] = (skips[reason] ?? 0) + 1;
  };
  const usedMakers = new Set<number>();
  let matched = 0;
  let plans = 0;
  let opens = 0;
  for (const taker of takers) {
    if (plans >= limits.maxPlans || opens >= limits.maxOpens) {
      skip("ROUND_WORK_CAP");
      continue;
    }
    const m = matcher.market(taker.record.market);
    if (!m) continue;
    if (limits.maxLockLifetime > 0n && taker.record.expiry - now > limits.maxLockLifetime) {
      skip("LOCK_LIFETIME_TOO_LONG");
      continue;
    }
    if (matcher.blocked(taker)) continue;
    let result: MatchResult = { matched: false, reason: "NO_MAKER" };
    for (const maker of makers) {
      if (usedMakers.has(maker.leafIndex) || maker.record.market !== taker.record.market || maker.record.asset !== taker.record.asset) continue;
      if (plans >= limits.maxPlans || opens >= limits.maxOpens) {
        result = { matched: false, reason: "ROUND_WORK_CAP" };
        break;
      }
      const inputs = await load(m);
      if (inputs.closeOnly) {
        result = { matched: false, reason: "MARKET_CLOSE_ONLY" };
        break;
      }
      if (!inputs.price.fresh) {
        result = { matched: false, reason: "ORACLE_UNAVAILABLE" };
        break;
      }
      const state = inputs.state;
      if (!state) {
        result = { matched: false, reason: "MARKET_STATE_UNREADABLE" };
        break;
      }
      plans++;
      const plan = matcher.plan(m, taker.record, maker.record, { ...inputs, state });
      if (plan.kind === "skip") {
        result = { matched: false, reason: plan.reason };
        if (plan.reason === "PRICE_OUTSIDE_LIMIT") break;
        continue;
      }
      opens++;
      result = await matcher.open(m, taker, maker);
      if (result.matched) {
        usedMakers.add(maker.leafIndex);
        matched++;
        cache.delete(m.id);
        break;
      }
      if (result.reason === "PROOF_REFUSED") matcher.onProofRefused(taker);
    }
    if (!result.matched && result.reason) skip(result.reason);
  }
  return { matched, usedMakers, skips, plans };
}
