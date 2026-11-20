import type { Hex } from "viem";

export interface FoldedRatioOptions {
  /** A folded ratio never changes short of a reorg, so it is kept this long. */
  readonly foldedTtlMs: number;
  /** "Not folded yet" is kept briefly, so polling wallets share one read. */
  readonly unfoldedTtlMs: number;
  readonly maxEntries: number;
  /** RPC reads in flight at once for one request. */
  readonly concurrency: number;
  readonly now?: () => number;
}

/**
 * foldedRatioPlusOne lookups for /v1/claims/ratio. Every answer is cached and repeated or concurrent asks for the same
 * delta share one read, so a request costs RPC calls only for deltas nobody asked about recently, and never more than
 * `concurrency` at a time against the shared RPC.
 */
export class FoldedRatios {
  private readonly cache = new Map<Hex, { ratioPlusOne: bigint; expiresAt: number }>();
  private readonly inFlight = new Map<Hex, Promise<bigint>>();
  private readonly now: () => number;

  constructor(
    private readonly read: (delta: Hex) => Promise<bigint>,
    private readonly opts: FoldedRatioOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** The folded ratio of each delta, or null while it is unfolded. */
  async ratios(deltas: readonly Hex[]): Promise<(bigint | null)[]> {
    const unique = [...new Set(deltas)];
    const values = new Map<Hex, bigint>();
    const misses: Hex[] = [];
    for (const d of unique) {
      const hit = this.cache.get(d);
      if (hit && hit.expiresAt > this.now()) values.set(d, hit.ratioPlusOne);
      else misses.push(d);
    }
    for (let i = 0; i < misses.length; i += this.opts.concurrency) {
      const batch = misses.slice(i, i + this.opts.concurrency);
      const read = await Promise.all(batch.map((d) => this.load(d)));
      batch.forEach((d, j) => values.set(d, read[j]!));
    }
    return deltas.map((d) => {
      const r = values.get(d) ?? 0n;
      return r === 0n ? null : r - 1n;
    });
  }

  private load(delta: Hex): Promise<bigint> {
    const pending = this.inFlight.get(delta);
    if (pending) return pending;
    const p = this.read(delta).then((ratioPlusOne) => {
      this.remember(delta, ratioPlusOne);
      return ratioPlusOne;
    }).finally(() => this.inFlight.delete(delta));
    this.inFlight.set(delta, p);
    return p;
  }

  private remember(delta: Hex, ratioPlusOne: bigint): void {
    this.cache.delete(delta);
    this.cache.set(delta, { ratioPlusOne, expiresAt: this.now() + (ratioPlusOne === 0n ? this.opts.unfoldedTtlMs : this.opts.foldedTtlMs) });
    while (this.cache.size > this.opts.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
