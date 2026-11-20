import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { NONCE_TTL_S } from "./token";

/**
 * The admin sign-in message (EIP-4361). Built in the browser and checked on the server from the same module, so the
 * two sides cannot drift. It is deliberately unrelated to accountMessage(), whose signature derives a private account.
 */
export const ADMIN_SIWE_STATEMENT = "Sign in to Rooq admin";
export const ADMIN_SIWE_MAX_LENGTH = 2048;
const MAX_AGE_MS = NONCE_TTL_S * 1000;
const CLOCK_SKEW_MS = 30_000;

export function adminSiweMessage(input: { address: `0x${string}`; origin: string; chainId: number; nonce: string; now: Date }): string {
  const site = new URL(input.origin);
  return createSiweMessage({
    address: input.address,
    chainId: input.chainId,
    domain: site.host,
    uri: site.origin,
    nonce: input.nonce,
    version: "1",
    statement: ADMIN_SIWE_STATEMENT,
    issuedAt: input.now,
    expirationTime: new Date(input.now.getTime() + MAX_AGE_MS),
  });
}

export type AdminSiweRejection = "malformed" | "wrong_site" | "wrong_chain" | "wrong_nonce" | "expired";

export type AdminSiweCheck = { ok: true; address: `0x${string}` } | { ok: false; reason: AdminSiweRejection };

/**
 * Checks every field the server relies on before any signature work. The message must also be byte-for-byte the
 * canonical rendering of its own fields, because viem's parser is lenient and would accept surrounding text.
 */
export function checkAdminSiwe(raw: string, expected: { origin: string; chainId: number; nonce: string; now: Date }): AdminSiweCheck {
  if (raw.length > ADMIN_SIWE_MAX_LENGTH) return { ok: false, reason: "malformed" };
  const fields = parseSiweMessage(raw);
  const { address, chainId, domain, nonce, uri, version, statement, issuedAt, expirationTime } = fields;
  if (!address || chainId === undefined || !domain || !nonce || !uri || version !== "1" || !issuedAt || !expirationTime) return { ok: false, reason: "malformed" };
  if (statement !== ADMIN_SIWE_STATEMENT || fields.notBefore || fields.requestId || fields.resources) return { ok: false, reason: "malformed" };
  if (!canonical(raw, { address, chainId, domain, nonce, uri, version, statement, issuedAt, expirationTime, scheme: fields.scheme })) return { ok: false, reason: "malformed" };

  const site = new URL(expected.origin);
  if (domain !== site.host || originOf(uri) !== site.origin) return { ok: false, reason: "wrong_site" };
  if (fields.scheme !== undefined && `${fields.scheme}:` !== site.protocol) return { ok: false, reason: "wrong_site" };
  if (chainId !== expected.chainId) return { ok: false, reason: "wrong_chain" };
  if (nonce !== expected.nonce) return { ok: false, reason: "wrong_nonce" };

  const now = expected.now.getTime();
  const issued = issuedAt.getTime();
  const expires = expirationTime.getTime();
  if (issued > now + CLOCK_SKEW_MS || now - issued > MAX_AGE_MS || expires <= now || expires - issued > MAX_AGE_MS) return { ok: false, reason: "expired" };
  return { ok: true, address };
}

function canonical(raw: string, fields: Parameters<typeof createSiweMessage>[0]): boolean {
  try {
    return createSiweMessage(fields) === raw;
  } catch {
    return false;
  }
}

function originOf(uri: string): string | null {
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}
