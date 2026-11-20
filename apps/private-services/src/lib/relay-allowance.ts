import type { Address, Hex } from "viem";
import { intEnv, type Env } from "./config";
import { RateLimiter } from "./http";
import type { RelayAction } from "./relay-codec";

const HOUR_MS = 3_600_000;

export interface AllowanceLimits {
  /** Unpaid relays per hour across every action and client: the ceiling on gas the relayer can be made to spend. */
  readonly perHour: number;
  /** Unpaid relays per hour for one action, so one cheap loop (an LP request toggled back and forth) can't use them all. */
  readonly perActionPerHour: number;
  /** Unpaid relays per hour for one client. */
  readonly perClientPerHour: number;
  /** Exit bonds this relayer may have fronted and not yet got back. */
  readonly maxFrontedBonds: number;
  /** On-chain reverts of one job before the same request is refused. */
  readonly maxRevertedAttempts: number;
}

export function allowanceLimits(env: Env): AllowanceLimits {
  return {
    perHour: intEnv(env, "RELAYER_FREE_PER_HOUR", 600, 0),
    perActionPerHour: intEnv(env, "RELAYER_FREE_PER_ACTION_PER_HOUR", 240, 0),
    perClientPerHour: intEnv(env, "RELAYER_FREE_PER_CLIENT_PER_HOUR", 60, 0),
    maxFrontedBonds: intEnv(env, "RELAYER_MAX_FRONTED_BONDS", 4, 0),
    maxRevertedAttempts: intEnv(env, "RELAYER_MAX_REVERTED_ATTEMPTS", 3, 1),
  };
}

export type AllowanceRefusal = "ALL" | "ACTION" | "CLIENT";

/**
 * Gas the relayer pays for with no fee. A request settled as "free" (no fee configured for it, or an action with no fee
 * output: exit requests, LP requests, operator-proved spot calls) draws on hourly allowances that bound total, per-action and
 * per-client spending. Paid requests and waived operator traffic don't (spec-fees.md section 5).
 */
export class RelayAllowance {
  private readonly window = new RateLimiter(HOUR_MS);

  constructor(private readonly limits: AllowanceLimits) {}

  /**
   * Charges `units` unpaid relays to every limit at once, or nothing and the first limit without room for all of them. An
   * LP add is two locks in one transaction, so it charges two units and is refused whole.
   */
  charge(action: RelayAction, client: string, now = Date.now(), units = 1): AllowanceRefusal | null {
    const refused = this.window.allowEach([
      { key: "all", limit: this.limits.perHour },
      { key: `action:${action}`, limit: this.limits.perActionPerHour },
      { key: `client:${client}`, limit: this.limits.perClientPerHour },
    ], now, units);
    if (refused === null) return null;
    return refused === "all" ? "ALL" : refused.startsWith("action:") ? "ACTION" : "CLIENT";
  }

  /** Gives back a charge whose relay was never sent. */
  refund(action: RelayAction, client: string, units = 1): void {
    this.window.refund(["all", `action:${action}`, `client:${client}`], units);
  }

  prune(now = Date.now()): void {
    this.window.prune(now);
  }
}

/** Exit bonds this relayer fronted for pairs still open; a consumed pair's bond is reclaimed on the next tick. */
export function frontedBonds(exits: readonly { readonly requester: Address; readonly nullifier: Hex }[], me: Address, consumed: (nullifier: Hex) => boolean): number {
  const mine = me.toLowerCase();
  let n = 0;
  for (const e of exits) if (e.requester.toLowerCase() === mine && !consumed(e.nullifier)) n++;
  return n;
}

/** A request whose transaction already reverted on chain this many times is refused rather than paid for again. */
export function retryLimitReached(job: { readonly status: string; readonly attempts: number } | undefined, maxRevertedAttempts: number): boolean {
  return job !== undefined && job.status === "reverted" && job.attempts >= maxRevertedAttempts;
}
