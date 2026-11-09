import { fromBytes, mod } from "@rooq/private-sdk";
import { concat, keccak256, toBytes, type Hex } from "viem";

const SIGNATURE_DOMAIN = toBytes("rooq/private-account/v1/signature");
const PRF_DOMAIN = toBytes("rooq/private-account/v1/passkey");

/** Keccak is 256 bits; two domain-separated halves make 512, so the reduction into the 254-bit field has no meaningful bias. */
function expandToField(domain: Uint8Array, secret: Uint8Array): bigint {
  const left = keccak256(concat([domain, secret, new Uint8Array([0])]), "bytes");
  const right = keccak256(concat([domain, secret, new Uint8Array([1])]), "bytes");
  return mod(fromBytes(concat([left, right])));
}

/** Never sent anywhere. Same wallet and message give the same signature, which gives the same seed. */
export const seedFromSignature = (signature: Hex): bigint => expandToField(SIGNATURE_DOMAIN, toBytes(signature));

export const seedFromPrf = (output: Uint8Array): bigint => expandToField(PRF_DOMAIN, output);
