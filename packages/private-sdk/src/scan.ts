import { FREE_DOMAIN } from "./constants";
import { decrypt } from "./encryption";
import { depositOpening, type WalletKeys } from "./keys";
import { noteCommitment, noteInner, ownerNullifier, type OwnedNote } from "./note";

/** `NotesCreated` as emitted by ShieldedPool, decoded. */
export interface CreatedNotes {
  readonly firstLeafIndex: number;
  readonly commitments: readonly bigint[];
  readonly ciphertexts: readonly (readonly bigint[])[];
}

/** `Shielded` as emitted by ShieldedPool, decoded. */
export interface ShieldedDeposit {
  readonly leafIndex: number;
  readonly asset: bigint;
  readonly amount: bigint;
  readonly inner: bigint;
}

/**
 * Finds notes owned by `keys` among created notes. A ciphertext is accepted only if its plaintext rebuilds the
 * on-chain commitment under this wallet's owner tag, so a malformed or foreign ciphertext is ignored.
 */
export function scanCreated(keys: WalletKeys, deployment: bigint, events: readonly CreatedNotes[]): OwnedNote[] {
  const found: OwnedNote[] = [];
  for (const ev of events) {
    ev.ciphertexts.forEach((ct, i) => {
      let pt: bigint[];
      try {
        pt = decrypt(ct, keys.encSk);
      } catch (err) {
        if (err instanceof Error && /Grumpkin point|ciphertext length/.test(err.message)) return;
        throw err;
      }
      const [domain, asset, value, rho, blind] = pt as [bigint, bigint, bigint, bigint, bigint];
      if (domain !== FREE_DOMAIN) return;
      const cm = noteCommitment(deployment, asset, value, noteInner(keys.owner, rho, blind));
      if (cm !== ev.commitments[i]) return;
      found.push({ leafIndex: ev.firstLeafIndex + i, asset, value, rho, blind, commitment: cm, nullifier: ownerNullifier(keys.nk, cm) });
    });
  }
  return found;
}

/**
 * Recovers this wallet's deposits from public `Shielded` events using seed-derived openings k = 0, 1, ...
 * Stops after `gap` consecutive unused indices.
 */
export function scanDeposits(seed: bigint, keys: WalletKeys, deployment: bigint, deposits: readonly ShieldedDeposit[], gap = 20): OwnedNote[] {
  const byInner = new Map(deposits.map((d) => [d.inner, d]));
  const found: OwnedNote[] = [];
  for (let k = 0, misses = 0; misses < gap; k++) {
    const { rho, blind } = depositOpening(seed, k);
    const d = byInner.get(noteInner(keys.owner, rho, blind));
    if (!d) {
      misses++;
      continue;
    }
    misses = 0;
    const cm = noteCommitment(deployment, d.asset, d.amount, d.inner);
    found.push({ leafIndex: d.leafIndex, asset: d.asset, value: d.amount, rho, blind, commitment: cm, nullifier: ownerNullifier(keys.nk, cm) });
  }
  return found;
}
