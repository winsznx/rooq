import { decrypt } from "./encryption";
import { mulGenerator, type Point } from "./crypto";
import { MARKET_PT_LEN } from "./constants";
import { marketHead, type MarketState } from "./pairs";
import { openPoolState, poolHead, type PoolState } from "./spot";

export interface HeldKey {
  readonly sk: bigint;
  readonly pk: Point;
}

/** A decrypted value and the position of the key that opened it, which says whether the record is still on a retired key. */
export interface RingHit<T> {
  readonly value: T;
  readonly keyIndex: number;
}

/**
 * The decryption keys one service holds: the one in effect now and any retired ones still needed for old records (D-24).
 * A retired key can read only what was encrypted to it, so which key opens a record is never guessed from time.
 */
export class KeyRing {
  readonly keys: readonly HeldKey[];

  constructor(secrets: readonly bigint[]) {
    if (secrets.length === 0) throw new Error("A key ring needs at least one key");
    const seen = new Set<bigint>();
    const keys: HeldKey[] = [];
    for (const sk of secrets) {
      if (seen.has(sk)) continue;
      seen.add(sk);
      keys.push({ sk, pk: mulGenerator(sk) });
    }
    this.keys = keys;
  }

  /** Position of the key with this public point, or -1 when this service does not hold it. */
  indexOf(pk: Point): number {
    return this.keys.findIndex((k) => k.pk.x === pk.x && k.pk.y === pk.y);
  }

  /** Tries each key until `open` accepts one. Openers check a commitment, so a wrong key returns null rather than garbage. */
  open<T>(open: (sk: bigint) => T | null): RingHit<T> | null {
    for (let keyIndex = 0; keyIndex < this.keys.length; keyIndex++) {
      const value = open(this.keys[keyIndex]!.sk);
      if (value !== null) return { value, keyIndex };
    }
    return null;
  }
}

/** A market ciphertext has no commitment of its own, so the record it must match is the on-chain head. */
export function openMarketState(ring: KeyRing, ct: readonly bigint[], deployment: bigint, market: bigint, head: bigint): RingHit<MarketState> | null {
  return ring.open((sk) => {
    const [longOi, shortOi, insurance, badDebt, bondUsed, blind] = decrypt(ct, sk, MARKET_PT_LEN) as [bigint, bigint, bigint, bigint, bigint, bigint];
    const state: MarketState = { longOi, shortOi, insurance, badDebt, bondUsed, blind };
    return marketHead(deployment, market, state) === head ? state : null;
  });
}

export function openPoolStateWith(ring: KeyRing, ct: readonly bigint[], deployment: bigint, pool: bigint, head: bigint): RingHit<PoolState> | null {
  return ring.open((sk) => {
    const state = openPoolState(ct, sk);
    return poolHead(deployment, pool, state) === head ? state : null;
  });
}
