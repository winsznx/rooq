import { NOTE_PT_LEN, T_ENC } from "./constants";
import { hash, isOnCurve, mul, mulGenerator, type Point } from "./crypto";
import { mod } from "./field";

/** [eph.x, eph.y, pt_i + H(T_ENC, shared.x, i)...], identical to `encrypt` in the circuits. */
export function encrypt(pt: readonly bigint[], pk: Point, eph: bigint): bigint[] {
  if (!isOnCurve(pk)) throw new Error("recipient key is not a Grumpkin point");
  const e = mulGenerator(eph);
  const shared = mul(pk, eph);
  return [e.x, e.y, ...pt.map((v, i) => mod(v + hash([T_ENC, shared.x, BigInt(i)])))];
}

export function decrypt(ct: readonly bigint[], encSk: bigint, len = NOTE_PT_LEN): bigint[] {
  if (ct.length !== len + 2) throw new Error("ciphertext length");
  const eph = { x: ct[0]!, y: ct[1]! };
  if (!isOnCurve(eph)) throw new Error("ephemeral key is not a Grumpkin point");
  const shared = mul(eph, encSk);
  return ct.slice(2).map((c, i) => mod(c - hash([T_ENC, shared.x, BigInt(i)])));
}
