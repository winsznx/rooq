import { T_AUTH, T_NK, T_OWNER, T_SEED } from "./constants";
import { hash, mulGenerator, type Point } from "./crypto";

/**
 * Wallet credentials (ADR-P01 key table). `sk` authorizes spends and must never leave the device.
 * `encSk` decrypts notes; it cannot spend. Both derive from one backup seed with distinct domains.
 */
export interface WalletKeys {
  readonly sk: bigint;
  readonly encSk: bigint;
  readonly auth: bigint;
  readonly nk: bigint;
  readonly pk: Point;
  readonly owner: bigint;
}

/** What a sender needs to pay this wallet. Reveals neither key. */
export interface PrivateAddress {
  readonly auth: bigint;
  readonly pk: Point;
}

export function deriveKeys(seed: bigint): WalletKeys {
  const sk = hash([T_SEED, seed, 1n]);
  const encSk = hash([T_SEED, seed, 2n]);
  const auth = hash([T_AUTH, sk]);
  const pk = mulGenerator(encSk);
  return { sk, encSk, auth, nk: hash([T_NK, sk]), pk, owner: ownerTag({ auth, pk }) };
}

export function ownerTag(a: PrivateAddress): bigint {
  return hash([T_OWNER, a.auth, a.pk.x, a.pk.y]);
}

export function addressOf(k: WalletKeys): PrivateAddress {
  return { auth: k.auth, pk: k.pk };
}

/**
 * Opening of the k-th deposit. Derived from the seed so a restored wallet can find its deposits by testing
 * k = 0, 1, 2, ... against `Shielded` events (REC-02) without any ciphertext.
 */
export function depositOpening(seed: bigint, k: number): { readonly rho: bigint; readonly blind: bigint } {
  return { rho: hash([T_SEED, seed, 3n, BigInt(k)]), blind: hash([T_SEED, seed, 4n, BigInt(k)]) };
}

/**
 * One-time payout address for the i-th lock (D-06). Coordinator and risk workers see only this, so they cannot link
 * one wallet's positions. Restored by testing i = 0, 1, 2, ... against the wallet's own lock records.
 */
export function lockAddressKeys(seed: bigint, i: number): WalletKeys {
  return deriveKeys(hash([T_SEED, seed, 5n, BigInt(i)]));
}
