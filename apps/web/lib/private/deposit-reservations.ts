import type { Hex } from "viem";

/**
 * Deposit opening indices handed out to shields the chain hasn't shown yet.
 *
 * A deposit's opening is derived from the seed and its index, so two shields with the same index, asset and amount
 * produce one commitment and one nullifier, and only one of them can ever be spent (internal audit finding 3). An index
 * is therefore stored before the wallet signs and stays reserved until the chain consumes it or shows its transaction
 * reverted. Only a shield that never left the wallet gives its index back.
 */
export interface DepositReservation {
  readonly index: number;
  /** The shield transaction, once the wallet broadcast it. */
  readonly hash: Hex | null;
  /**
   * The pool already holds a deposit with this index's opening (ShieldedPool refuses a reused `inner`), placed by another
   * tab or device on this account, or one the read API hasn't indexed yet. Skipped until the scanner passes it.
   */
  readonly taken?: true;
}

const TAKEN = "taken";

export type ReceiptStatus = "success" | "reverted" | null;

export class DepositReservations {
  private readonly items = new Map<number, Hex | null | typeof TAKEN>();

  /** `gap` is how many unused indices in a row the scanner reads past before it stops looking. */
  constructor(private readonly gap: number, stored: readonly DepositReservation[] = []) {
    for (const r of stored) this.items.set(r.index, r.taken ? TAKEN : r.hash);
  }

  /** The next free index at or after `nextDeposit`, or null when one more would leave a gap the scanner can't cross. */
  reserve(nextDeposit: number): number | null {
    let k = nextDeposit;
    while (this.items.has(k)) k++;
    if (k - nextDeposit >= this.gap) return null;
    this.items.set(k, null);
    return k;
  }

  sent(index: number, hash: Hex): void {
    if (this.items.has(index)) this.items.set(index, hash);
  }

  /** The chain already used this index's opening, so it can never be shielded to again. */
  taken(index: number): void {
    this.items.set(index, TAKEN);
  }

  /** The person's wallet is done. A shield that was never broadcast frees its index; a broadcast one keeps it. */
  finished(index: number): void {
    if (this.items.get(index) === null) this.items.delete(index);
  }

  /** Drops indices the chain consumed and those whose transaction reverted. True when anything changed. */
  async settle(nextDeposit: number, receipt: (hash: Hex) => Promise<ReceiptStatus>): Promise<boolean> {
    let changed = false;
    for (const [index, hash] of [...this.items]) {
      if (index < nextDeposit || (hash !== null && hash !== TAKEN && (await receipt(hash)) === "reverted")) {
        this.items.delete(index);
        changed = true;
      }
    }
    return changed;
  }

  list(): DepositReservation[] {
    return [...this.items].map(([index, hash]) => (hash === TAKEN ? { index, hash: null, taken: true as const } : { index, hash }));
  }
}

/**
 * Reserves the next index whose opening the pool hasn't seen, marking used ones as taken on the way. Null when the scanner's
 * gap is exhausted. A failed `isUsed` gives the index back before rethrowing.
 */
export async function reserveUnused(r: DepositReservations, nextDeposit: number, isUsed: (index: number) => Promise<boolean>): Promise<number | null> {
  for (;;) {
    const k = r.reserve(nextDeposit);
    if (k === null) return null;
    let used: boolean;
    try {
      used = await isUsed(k);
    } catch (error) {
      r.finished(k);
      throw error;
    }
    if (!used) return k;
    r.taken(k);
  }
}
