import "server-only";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { adminAuthEnv, type AdminAuthEnv } from "./env";
import { importSigningKey, readSession, type AdminSession } from "./token";

export type { AdminSession } from "./token";

export interface AdminCookieNames {
  session: string;
  nonce: string;
}

/** The __Host- prefix pins each cookie to this exact host over HTTPS with Path=/; browsers drop it without Secure. */
export function adminCookieNames(env: AdminAuthEnv): AdminCookieNames {
  return env.secure ? { session: "__Host-rooq_admin", nonce: "__Host-rooq_admin_nonce" } : { session: "rooq_admin_dev", nonce: "rooq_admin_nonce_dev" };
}

export interface AdminCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
  path: "/";
  maxAge: number;
}

export function adminCookieOptions(env: AdminAuthEnv, maxAge: number): AdminCookieOptions {
  return { httpOnly: true, secure: env.secure, sameSite: "strict", path: "/", maxAge };
}

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

export function adminSigningKey(env: AdminAuthEnv): Promise<CryptoKey> {
  if (cachedKey?.secret !== env.secret) cachedKey = { secret: env.secret, key: importSigningKey(env.secret) };
  return cachedKey.key;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Verifies the cookie and re-checks the allowlist and the session epoch, so removing an address from ADMIN_ADDRESSES
 * ends its sessions and raising ADMIN_SESSION_EPOCH ends everyone's.
 */
export async function verifyAdminCookie(env: AdminAuthEnv, value: string | undefined): Promise<AdminSession | null> {
  if (!value) return null;
  const session = await readSession(await adminSigningKey(env), value, nowSeconds(), env.sessionEpoch);
  return session && env.addresses.has(session.address) ? session : null;
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const env = adminAuthEnv();
  if (!env) return null;
  const jar = await cookies();
  return verifyAdminCookie(env, jar.get(adminCookieNames(env).session)?.value);
}

/**
 * For every admin page except the bare /admin, which offers sign-in. Anyone without a session gets the site's 404
 * from the server, whether or not the proxy ran, and not a hint that the page exists.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) notFound();
  return session;
}

/** A page title that resolves only for a signed-in admin, so the 404 doesn't carry "Wallets | Rooq admin". */
export function adminPageMetadata(title: string): () => Promise<Metadata> {
  return async () => {
    await requireAdmin();
    return { title };
  };
}
