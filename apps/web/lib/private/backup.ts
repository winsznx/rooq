import { fromBytes, mod } from "@rooq/private-sdk";
import { compactSignatureToSignature, concat, keccak256, numberToBytes, parseCompactSignature, parseSignature, size, toBytes, type Hex } from "viem";
import type { AccountDerivation } from "./deployment-pin";

const SIGNATURE_DOMAIN: Record<AccountDerivation, Uint8Array> = {
  1: toBytes("rooq/private-account/v1/signature"),
  2: toBytes("rooq/private-account/v2/signature"),
};
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const PRF_DOMAIN = toBytes("rooq/private-account/v1/passkey");

/** Keccak is 256 bits; two domain-separated halves make 512, so the reduction into the 254-bit field has no meaningful bias. */
function expandToField(domain: Uint8Array, secret: Uint8Array): bigint {
  const left = keccak256(concat([domain, secret, new Uint8Array([0])]), "bytes");
  const right = keccak256(concat([domain, secret, new Uint8Array([1])]), "bytes");
  return mod(fromBytes(concat([left, right])));
}

/**
 * One encoding per signature: wallets differ in v (27/28 or 0/1), some return the 64-byte compact form, and s may be high.
 * All of them recover the same signer, so all of them must give the same account (audit 27).
 */
export function normalizedSignature(signature: Hex): Uint8Array {
  const parsed = size(signature) === 64 ? compactSignatureToSignature(parseCompactSignature(signature)) : parseSignature(signature);
  let s = BigInt(parsed.s);
  let yParity = parsed.yParity ?? 0;
  if (s > SECP256K1_N / 2n) {
    s = SECP256K1_N - s;
    yParity ^= 1;
  }
  return concat([numberToBytes(BigInt(parsed.r), { size: 32 }), numberToBytes(s, { size: 32 }), new Uint8Array([yParity])]);
}

/** Never sent anywhere. Same wallet and message give the same signature, which gives the same seed. */
export function seedFromSignature(signature: Hex, derivation: AccountDerivation): bigint {
  // Version 1 hashed the raw bytes; accounts opened that way keep it until their deployment retires.
  const secret = derivation === 1 ? toBytes(signature) : normalizedSignature(signature);
  return expandToField(SIGNATURE_DOMAIN[derivation], secret);
}

export const seedFromPrf = (output: Uint8Array): bigint => expandToField(PRF_DOMAIN, output);
