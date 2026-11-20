import type { Hex } from "viem";

/**
 * Claim ratios, read for every folded open-interest change in every market and looked up here.
 *
 * Asking the RPC for foldedRatioPlusOne(deltaCm) of one claim names the liquidated pair this wallet won, since deltaCm
 * is public in the liquidation's inputs (internal audit finding 10). Reading every folded delta instead makes the
 * requests the same whichever claim the wallet holds.
 */
export interface FoldedReader {
  /** How many of the market's open-interest changes funding has folded so far. */
  consumed(market: bigint): Promise<bigint>;
  oiDeltas(market: bigint, indices: readonly bigint[]): Promise<readonly Hex[]>;
  /** foldedRatioPlusOne for each delta, in order. */
  ratiosPlusOne(deltas: readonly Hex[]): Promise<readonly bigint[]>;
}

export interface MarketStamp {
  readonly id: bigint;
  /** Changes whenever the market's funding advances, so a market with no new epoch isn't read again. */
  readonly stamp: string;
}

const CHUNK = 256;

export class FoldedRatios {
  private readonly ratios = new Map<string, bigint>();
  private readonly next = new Map<bigint, bigint>();
  private readonly stamps = new Map<bigint, string>();

  async refresh(markets: readonly MarketStamp[], reader: FoldedReader): Promise<void> {
    for (const m of markets) {
      if (this.stamps.get(m.id) === m.stamp) continue;
      const consumed = await reader.consumed(m.id);
      for (let from = this.next.get(m.id) ?? 0n; from < consumed; from += BigInt(CHUNK)) {
        const to = from + BigInt(CHUNK) < consumed ? from + BigInt(CHUNK) : consumed;
        const indices = Array.from({ length: Number(to - from) }, (_, i) => from + BigInt(i));
        const deltas = await reader.oiDeltas(m.id, indices);
        const values = await reader.ratiosPlusOne(deltas);
        // Every consumed delta has folded, so a zero is an RPC backend behind the head. Keep what came before it and read
        // from it again next time, or a claim on that delta would never turn redeemable this session.
        const lagging = deltas.findIndex((_, i) => (values[i] ?? 0n) === 0n);
        const usable = lagging === -1 ? deltas.length : lagging;
        // A delta folded twice holds its latest ratio, and the later read overwrites the earlier one here too.
        for (let i = 0; i < usable; i++) this.ratios.set(deltas[i]!.toLowerCase(), values[i]! - 1n);
        this.next.set(m.id, from + BigInt(usable));
        if (lagging !== -1) break;
      }
      if ((this.next.get(m.id) ?? 0n) < consumed) continue;
      this.stamps.set(m.id, m.stamp);
    }
  }

  get(delta: Hex): bigint | null {
    return this.ratios.get(delta.toLowerCase()) ?? null;
  }

  clear(): void {
    this.ratios.clear();
    this.next.clear();
    this.stamps.clear();
  }
}
