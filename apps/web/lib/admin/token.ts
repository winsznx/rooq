/**
 * HMAC-SHA256 tokens for the admin session and sign-in nonce cookies. Pure Web Crypto with no Next imports, so the
 * proxy, the route handlers and the unit tests share one implementation. The purpose is part of the signed bytes,
 * so a nonce token can never be replayed as a session token.
 */

export const SESSION_TTL_S = 12 * 60 * 60;
/** Also the longest a sign-in message stays valid. Short, because a stateless nonce can be replayed until it expires. */
export const NONCE_TTL_S = 2 * 60;
/** Tolerated forward clock drift between the Vercel functions that issue and check a token. */
const CLOCK_SKEW_S = 60;

export interface AdminSession {
  /** Lowercased. */
  address: `0x${string}`;
  /** Unix seconds. */
  exp: number;
}

type Purpose = "session" | "nonce";

const encoder = new TextEncoder();
const MAC_B64URL = /^[A-Za-z0-9_-]{43}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UNIX_SECONDS = /^[1-9][0-9]{0,11}$/;
/** EIP-4361 nonces are at least 8 alphanumeric characters. */
const SIWE_NONCE = /^[A-Za-z0-9]{8,128}$/;

export function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueSession(key: CryptoKey, address: `0x${string}`, now: number): Promise<{ token: string; session: AdminSession }> {
  const session: AdminSession = { address: address.toLowerCase() as `0x${string}`, exp: now + SESSION_TTL_S };
  const token = await seal(key, "session", [session.address, String(now), String(session.exp)]);
  return { token, session };
}

/** `notBefore` revokes every session issued earlier: setting ADMIN_SESSION_EPOCH ends stolen or forgotten sessions. */
export async function readSession(key: CryptoKey, token: string, now: number, notBefore = 0): Promise<AdminSession | null> {
  const fields = await unseal(key, "session", token, 3);
  if (!fields) return null;
  const [address = "", iatField = "", expField = ""] = fields;
  if (!ADDRESS.test(address) || !UNIX_SECONDS.test(iatField) || !UNIX_SECONDS.test(expField)) return null;
  const iat = Number(iatField);
  const exp = Number(expField);
  if (iat < notBefore || iat > now + CLOCK_SKEW_S || exp <= now || exp - iat > SESSION_TTL_S) return null;
  return { address: address as `0x${string}`, exp };
}

export function issueNonce(key: CryptoKey, nonce: string, now: number): Promise<string> {
  if (!SIWE_NONCE.test(nonce)) throw new Error("SIWE nonce must be 8 to 128 alphanumeric characters");
  return seal(key, "nonce", [nonce, String(now + NONCE_TTL_S)]);
}

export async function readNonce(key: CryptoKey, token: string, now: number): Promise<string | null> {
  const fields = await unseal(key, "nonce", token, 2);
  if (!fields) return null;
  const [nonce = "", expField = ""] = fields;
  if (!SIWE_NONCE.test(nonce) || !UNIX_SECONDS.test(expField)) return null;
  const exp = Number(expField);
  if (exp <= now || exp - now > NONCE_TTL_S + CLOCK_SKEW_S) return null;
  return nonce;
}

async function seal(key: CryptoKey, purpose: Purpose, fields: readonly string[]): Promise<string> {
  const body = fields.join(".");
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}:${body}`));
  return `${body}.${toBase64Url(new Uint8Array(mac))}`;
}

/** `crypto.subtle.verify` compares MACs in constant time; never compare the encoded strings directly. */
async function unseal(key: CryptoKey, purpose: Purpose, token: string, fieldCount: number): Promise<string[] | null> {
  const parts = token.split(".");
  if (parts.length !== fieldCount + 1) return null;
  const encodedMac = parts[fieldCount]!;
  if (!MAC_B64URL.test(encodedMac)) return null;
  const fields = parts.slice(0, fieldCount);
  const valid = await crypto.subtle.verify("HMAC", key, fromBase64Url(encodedMac), encoder.encode(`${purpose}:${fields.join(".")}`));
  return valid ? fields : null;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Callers check the alphabet and length first, so `atob` cannot throw here. */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
