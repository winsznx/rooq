import { deriveKeys, LOCK_CT_LEN, lockAddressKeys, openLock, RECORD_FREE, RECORD_LOCK, scanCreated, scanDeposits, type LockRecord, type OwnedNote, type ShieldedDeposit, type WalletKeys } from "@rooq/private-sdk";

export interface WalletRecord {
  readonly leafIndex: number;
  readonly kind: number;
  readonly commitment: bigint;
  readonly ciphertext: readonly bigint[];
}

export type SpendableNote = OwnedNote & { readonly keys: WalletKeys };

export interface OwnLock {
  readonly record: LockRecord;
  readonly leafIndex: number;
  readonly commitment: bigint;
}

/**
 * A shielded wallet rebuilt from a backup seed and public chain data (REC-02). Decrypt results are memoised by
 * commitment, so a rescan of current records only costs work for new records or newly discovered one-time addresses.
 */
export class ShieldedWallet {
  readonly main: WalletKeys;
  private readonly lockCache = new Map<bigint, LockRecord | null>();
  private readonly noteCache = new Map<string, OwnedNote | null>();
  private readonly addressCache = new Map<number, WalletKeys>();

  constructor(
    readonly seed: bigint,
    readonly deployment: bigint,
    private readonly addressGap = 30,
  ) {
    this.main = deriveKeys(seed);
  }

  /** The wallet's own copies of its locks, encrypted to the main key at slot 0 (D-06). */
  ownLocks(records: readonly WalletRecord[]): OwnLock[] {
    const out: OwnLock[] = [];
    for (const r of records) {
      if (r.kind !== RECORD_LOCK) continue;
      let record = this.lockCache.get(r.commitment);
      if (record === undefined) {
        record = openLock(r.ciphertext.slice(0, LOCK_CT_LEN), this.main.encSk, this.deployment, r.commitment);
        this.lockCache.set(r.commitment, record);
      }
      if (record) out.push({ record, leafIndex: r.leafIndex, commitment: r.commitment });
    }
    return out;
  }

  addressKeys(index: number): WalletKeys {
    let keys = this.addressCache.get(index);
    if (!keys) {
      keys = lockAddressKeys(this.seed, index);
      this.addressCache.set(index, keys);
    }
    return keys;
  }

  /** One-time addresses this wallet has used, by index, and the next unused index. */
  usedAddresses(records: readonly WalletRecord[]): { readonly used: readonly WalletKeys[]; readonly next: number } {
    const payouts = new Set(this.ownLocks(records).map((l) => l.record.ownerX));
    const used: WalletKeys[] = [];
    let next = 0;
    for (let i = 0, misses = 0; misses < this.addressGap; i++) {
      const k = this.addressKeys(i);
      if (payouts.has(k.pk.x)) {
        used.push(k);
        next = i + 1;
        misses = 0;
      } else {
        misses++;
      }
    }
    return { used, next };
  }

  private ownedBy(keys: WalletKeys, r: WalletRecord): OwnedNote | null {
    const cacheKey = `${keys.pk.x}:${r.commitment}`;
    let note = this.noteCache.get(cacheKey);
    if (note === undefined) {
      note = scanCreated(keys, this.deployment, [{ firstLeafIndex: r.leafIndex, commitments: [r.commitment], ciphertexts: [r.ciphertext] }])[0] ?? null;
      this.noteCache.set(cacheKey, note);
    }
    return note;
  }

  /** Spendable notes among current records, unspent and in the tree. */
  notes(records: readonly WalletRecord[], deposits: readonly ShieldedDeposit[], processed: number, isSpent: (nullifier: bigint) => boolean): SpendableNote[] {
    const mine: SpendableNote[] = scanDeposits(this.seed, this.main, this.deployment, deposits).map((n) => ({ ...n, keys: this.main }));
    const free = records.filter((r) => r.kind === RECORD_FREE);
    for (const keys of [this.main, ...this.usedAddresses(records).used]) {
      for (const r of free) {
        const n = this.ownedBy(keys, r);
        if (n) mine.push({ ...n, keys });
      }
    }
    return mine.filter((n) => n.value > 0n && n.leafIndex < processed && !isSpent(n.nullifier)).sort((a, b) => a.leafIndex - b.leafIndex);
  }
}
