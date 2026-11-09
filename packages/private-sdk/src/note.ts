import { FREE_DOMAIN, RECORD_VERSION, T_INNER, T_NF, T_NOTE, T_RHO } from "./constants";
import { hash } from "./crypto";

export function noteInner(owner: bigint, rho: bigint, blind: bigint): bigint {
  return hash([T_INNER, owner, rho, blind]);
}

export function noteCommitment(deployment: bigint, asset: bigint, value: bigint, inner: bigint, domain = FREE_DOMAIN): bigint {
  return hash([T_NOTE, deployment, RECORD_VERSION, domain, asset, value, inner]);
}

export function ownerNullifier(nk: bigint, cm: bigint): bigint {
  return hash([T_NF, nk, cm]);
}

export function outputRho(nf0: bigint, nf1: bigint, index: number): bigint {
  return hash([T_RHO, nf0, nf1, BigInt(index)]);
}

/** A FREE note this wallet can spend. */
export interface OwnedNote {
  readonly leafIndex: number;
  readonly asset: bigint;
  readonly value: bigint;
  readonly rho: bigint;
  readonly blind: bigint;
  readonly commitment: bigint;
  readonly nullifier: bigint;
}
