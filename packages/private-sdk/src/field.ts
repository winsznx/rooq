/** BN254 scalar field: every committed value, hash and public input lives here. */
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export type Hex = `0x${string}`;

export function mod(x: bigint): bigint {
  const r = x % FIELD;
  return r < 0n ? r + FIELD : r;
}

export function assertField(x: bigint, what: string): bigint {
  if (x < 0n || x >= FIELD) throw new RangeError(`${what} is not a field element`);
  return x;
}

export function toBytes32(x: bigint): Uint8Array {
  if (x < 0n || x >= 1n << 256n) throw new RangeError("value does not fit 32 bytes");
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function fromBytes(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

export function toHex32(x: bigint): Hex {
  return `0x${x.toString(16).padStart(64, "0")}`;
}

/** Uniform enough for keys and blinds: 512 random bits reduced mod the ~254-bit field (bias below 2^-250). */
export function randomField(): bigint {
  const bytes = new Uint8Array(64);
  globalThis.crypto.getRandomValues(bytes);
  return mod(fromBytes(bytes));
}
