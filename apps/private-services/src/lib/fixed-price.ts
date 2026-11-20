import { toFeedUnits } from "@rooq/config";
import type { Hex } from "viem";
import { intEnv, type Env } from "./config";
import type { FeedBounds } from "./price-guard";

/**
 * TEST ONLY. A feed whose token has no external price, such as a partner's test token, gets a fixed reference price with a
 * small random wobble so its round keeps moving and the market stays fresh. It carries no market information at all; the
 * app's TEST relay label covers it like every other feed this relay writes.
 */
export interface FixedFeed {
  readonly feedId: Hex;
  readonly label: string;
  readonly reference8: bigint;
}

const ENTRY = /^(0x[0-9a-fA-F]{64}):([A-Za-z0-9._-]{1,32}):(\d+(?:\.\d{1,8})?)$/;

/** Parses `RELAY_FIXED_FEEDS`: comma-separated `feedId:LABEL:price`, price in USD with up to 8 decimals. */
export function parseFixedFeeds(raw: string | undefined): ReadonlyMap<Hex, FixedFeed> {
  const feeds = new Map<Hex, FixedFeed>();
  if (!raw?.trim()) return feeds;
  for (const part of raw.split(",")) {
    const match = ENTRY.exec(part.trim());
    if (!match) throw new Error(`RELAY_FIXED_FEEDS entry "${part.trim()}" is not feedId:LABEL:price`);
    const feedId = match[1]!.toLowerCase() as Hex;
    const reference8 = toFeedUnits(match[3]!);
    if (reference8 === 0n) throw new Error(`RELAY_FIXED_FEEDS price for ${match[2]} must be above zero`);
    if (feeds.has(feedId)) throw new Error(`RELAY_FIXED_FEEDS lists ${feedId} twice`);
    feeds.set(feedId, { feedId, label: match[2]!, reference8 });
  }
  return feeds;
}

export function fixedJitterBps(env: Env): bigint {
  const bps = intEnv(env, "RELAY_FIXED_JITTER_BPS", 20, 0);
  if (bps >= 1_000) throw new Error("RELAY_FIXED_JITTER_BPS must stay below 1000");
  return BigInt(bps);
}

/** The reference moved by a uniform amount within +/- jitterBps, then held inside the feed's bounds. `random` returns [0, 1). */
export function jitteredAnswer(reference8: bigint, jitterBps: bigint, bounds: FeedBounds, random: () => number = Math.random): bigint {
  const span = 2n * jitterBps + 1n;
  const offsetBps = BigInt(Math.min(Math.floor(random() * Number(span)), Number(span) - 1)) - jitterBps;
  const answer = reference8 + (reference8 * offsetBps) / 10_000n;
  return answer < bounds.min8 ? bounds.min8 : answer > bounds.max8 ? bounds.max8 : answer;
}
