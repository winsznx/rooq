/**
 * Frozen reader for RECORD_VERSION 1 records, the layout before M36. Only for the migration window: a wallet on a v1
 * deployment needs to show its FREE notes, locks and pairs and recognise them on chain before it unshields. Pick it by the
 * deployment's record version (`recordsFor`), never by trial decoding. Nothing here proves: v1 proofs need the v1
 * circuit artifacts, which this package does not ship.
 *
 * Differences from v1 to v2: every commitment hashes version 1; `Pair` has no `updated_at` (plaintext 20 fields);
 * `PoolState` has no protocol accruals (5 fields); `LpClaim` slots 6 and 7 meant absolute minimum outputs.
 */
import { FREE_DOMAIN, RECORD_VERSION, T_LOCK, T_NOTE, T_PAIR, T_POOL, T_TERMS } from "../constants.js";
import { hash } from "../crypto.js";
import { decrypt } from "../encryption.js";
import type { WalletKeys } from "../keys.js";
import { noteInner, ownerNullifier, type OwnedNote } from "../note.js";
import type { LockRecord, PairRecord } from "../pairs.js";
import type { CreatedNotes } from "../scan.js";

export const RECORD_VERSION_V1 = 1n;
export const LOCK_PT_LEN_V1 = 13;
export const PAIR_PT_LEN_V1 = 20;
export const POOL_PT_LEN_V1 = 5;

/** v1 pairs carry no `updatedAt`; it reads as 0 here, which is also what a cooldown check against it would allow. */
export type PairRecordV1 = Omit<PairRecord, "updatedAt">;

export interface PoolStateV1 {
  readonly r0: bigint;
  readonly r1: bigint;
  readonly supply: bigint;
  readonly lastLeaf: bigint;
  readonly blind: bigint;
}

export function noteCommitmentV1(deployment: bigint, asset: bigint, value: bigint, inner: bigint, domain = FREE_DOMAIN): bigint {
  return hash([T_NOTE, deployment, RECORD_VERSION_V1, domain, asset, value, inner]);
}

export function lockCommitmentV1(deployment: bigint, l: LockRecord): bigint {
  const terms = hash([T_TERMS, l.role, l.market, l.t2, l.t3, l.t4]);
  return hash([T_LOCK, deployment, RECORD_VERSION_V1, l.asset, l.amount, l.ownerAuth, l.ownerX, l.ownerY, terms, l.expiry, l.recNonce, l.blind]);
}

const pairPlaintextV1 = (p: PairRecordV1): bigint[] => [
  p.market, p.asset, p.isShort, p.size, p.entry, p.fundingIndex, p.closeSpread, p.fundingDebt, p.debtByTaker, p.lastReduce, p.takerMargin, p.makerMargin,
  p.takerAuth, p.takerX, p.takerY, p.makerAuth, p.makerX, p.makerY, p.recNonce, p.blind,
];

export function pairCommitmentV1(deployment: bigint, p: PairRecordV1): bigint {
  return hash([T_PAIR, deployment, RECORD_VERSION_V1, ...pairPlaintextV1(p)]);
}

export function poolHeadV1(deployment: bigint, pool: bigint, s: PoolStateV1): bigint {
  return hash([T_POOL, deployment, RECORD_VERSION_V1, pool, s.r0, s.r1, s.supply, s.lastLeaf, s.blind]);
}

function decryptOrNull(ct: readonly bigint[], encSk: bigint, len: number): bigint[] | null {
  try {
    return decrypt(ct, encSk, len);
  } catch (err) {
    if (err instanceof Error && /Grumpkin point|ciphertext length/.test(err.message)) return null;
    throw err;
  }
}

/** v1 `scanCreated`: notes owned by `keys`, accepted only if they rebuild the on-chain v1 commitment. */
export function scanCreatedV1(keys: WalletKeys, deployment: bigint, events: readonly CreatedNotes[]): OwnedNote[] {
  const found: OwnedNote[] = [];
  for (const ev of events) {
    ev.ciphertexts.forEach((ct, i) => {
      const pt = decryptOrNull(ct, keys.encSk, 5);
      if (!pt) return;
      const [domain, asset, value, rho, blind] = pt as [bigint, bigint, bigint, bigint, bigint];
      if (domain !== FREE_DOMAIN) return;
      const cm = noteCommitmentV1(deployment, asset, value, noteInner(keys.owner, rho, blind));
      if (cm !== ev.commitments[i]) return;
      found.push({ leafIndex: ev.firstLeafIndex + i, asset, value, rho, blind, commitment: cm, nullifier: ownerNullifier(keys.nk, cm) });
    });
  }
  return found;
}

export function openLockV1(ct: readonly bigint[], encSk: bigint, deployment: bigint, commitment: bigint): LockRecord | null {
  const pt = decryptOrNull(ct, encSk, LOCK_PT_LEN_V1);
  if (!pt) return null;
  const [asset, amount, ownerAuth, ownerX, ownerY, role, market, t2, t3, t4, expiry, recNonce, blind] = pt as [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
  ];
  const l: LockRecord = { asset, amount, ownerAuth, ownerX, ownerY, role, market, t2, t3, t4, expiry, recNonce, blind };
  return lockCommitmentV1(deployment, l) === commitment ? l : null;
}

export function openPairV1(ct: readonly bigint[], encSk: bigint, deployment: bigint, commitment: bigint): PairRecordV1 | null {
  const pt = decryptOrNull(ct, encSk, PAIR_PT_LEN_V1);
  if (!pt) return null;
  const [market, asset, isShort, size, entry, fundingIndex, closeSpread, fundingDebt, debtByTaker, lastReduce, takerMargin, makerMargin, takerAuth, takerX, takerY, makerAuth, makerX, makerY, recNonce, blind] = pt as [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
  ];
  const p: PairRecordV1 = { market, asset, isShort, size, entry, fundingIndex, closeSpread, fundingDebt, debtByTaker, lastReduce, takerMargin, makerMargin, takerAuth, takerX, takerY, makerAuth, makerX, makerY, recNonce, blind };
  return pairCommitmentV1(deployment, p) === commitment ? p : null;
}

/** Which reader a deployment's records need. Throws on a version this package doesn't know. */
export function recordsFor(recordVersion: bigint): "current" | "v1" {
  if (recordVersion === RECORD_VERSION) return "current";
  if (recordVersion === RECORD_VERSION_V1) return "v1";
  throw new RangeError(`unknown record version ${recordVersion}`);
}
