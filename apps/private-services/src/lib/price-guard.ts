import { intEnv, type Env } from "./config";

export interface PriceGuardLimits {
  /** Widest bid/ask spread accepted, in bps of the mid. */
  readonly maxSpreadBps: bigint;
  /** Largest move from the last written answer accepted on one read. A larger one is written only once a second poll agrees. */
  readonly maxJumpBps: bigint;
  /** How close the confirming poll must be to the first one, in bps. */
  readonly confirmBps: bigint;
}

export function priceGuardLimits(env: Env): PriceGuardLimits {
  return {
    maxSpreadBps: BigInt(intEnv(env, "RELAY_MAX_SPREAD_BPS", 300, 1)),
    maxJumpBps: BigInt(intEnv(env, "RELAY_MAX_JUMP_BPS", 1_000, 1)),
    confirmBps: BigInt(intEnv(env, "RELAY_CONFIRM_BPS", 100, 0)),
  };
}

/** A source quote in feed units (8 decimals), multiplier applied to the mid. */
export interface GuardQuote {
  readonly bid8: bigint;
  readonly ask8: bigint;
  readonly answer8: bigint;
}

/** The feed's accepted range in feed units, from the oracle's feedConfig. */
export interface FeedBounds {
  readonly min8: bigint;
  readonly max8: bigint;
}

export type GuardSkip = "CROSSED_OR_ZERO" | "WIDE_SPREAD" | "OUT_OF_BOUNDS" | "JUMP_UNCONFIRMED";

const BPS = 10_000n;

const distanceBps = (a: bigint, from: bigint): bigint => ((a > from ? a - from : from - a) * BPS) / from;

/**
 * Decides whether a source quote may be written to a feed. Fail-closed like the source checks: a crossed, zero, wide or
 * out-of-range quote is never written, and a jump past `maxJumpBps` from the last written answer waits for the next poll
 * to land near it, so one bad print can't move the mark that liquidations read.
 */
export class PriceGuard {
  private readonly candidates = new Map<string, bigint>();

  constructor(private readonly limits: PriceGuardLimits) {}

  check(feed: string, q: GuardQuote, lastAnswer8: bigint, bounds: FeedBounds): GuardSkip | null {
    if (q.bid8 <= 0n || q.ask8 < q.bid8 || q.answer8 <= 0n) return this.refuse(feed, "CROSSED_OR_ZERO");
    const mid = (q.bid8 + q.ask8) / 2n;
    if ((q.ask8 - q.bid8) * BPS > mid * this.limits.maxSpreadBps) return this.refuse(feed, "WIDE_SPREAD");
    if (q.answer8 < bounds.min8 || q.answer8 > bounds.max8) return this.refuse(feed, "OUT_OF_BOUNDS");
    if (lastAnswer8 > 0n && distanceBps(q.answer8, lastAnswer8) > this.limits.maxJumpBps) {
      const candidate = this.candidates.get(feed);
      if (candidate === undefined || distanceBps(q.answer8, candidate) > this.limits.confirmBps) {
        this.candidates.set(feed, q.answer8);
        return "JUMP_UNCONFIRMED";
      }
    }
    this.candidates.delete(feed);
    return null;
  }

  private refuse(feed: string, reason: GuardSkip): GuardSkip {
    this.candidates.delete(feed);
    return reason;
  }
}
