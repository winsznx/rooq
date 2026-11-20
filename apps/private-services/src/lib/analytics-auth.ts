import { createHash, timingSafeEqual } from "node:crypto";
import type { Env } from "./config";
import { ServiceError } from "./errors";

/** 32 characters of a random token is well past guessing over a rate-limited public route. */
export const MIN_ADMIN_TOKEN_LENGTH = 32;

export type AdminTokenStatus = { readonly ok: true; readonly token: string } | { readonly ok: false; readonly reason: "ADMIN_TOKEN_MISSING" | "ADMIN_TOKEN_TOO_SHORT" };

/** Reads ADMIN_API_TOKEN and removes it from the environment. A missing or short token disables the admin routes. */
export function takeAdminToken(env: Env): AdminTokenStatus {
  const raw = env.ADMIN_API_TOKEN?.trim() ?? "";
  delete env.ADMIN_API_TOKEN;
  if (raw === "") return { ok: false, reason: "ADMIN_TOKEN_MISSING" };
  if (raw.length < MIN_ADMIN_TOKEN_LENGTH) return { ok: false, reason: "ADMIN_TOKEN_TOO_SHORT" };
  return { ok: true, token: raw };
}

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * True only for `Authorization: Bearer <token>` with the exact token. Both sides are hashed first, so the comparison is
 * constant time and does not reveal the token's length either.
 */
export function bearerMatches(header: string | null, expected: string): boolean {
  if (expected.length < MIN_ADMIN_TOKEN_LENGTH) return false;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "");
  return timingSafeEqual(digest(match?.[1] ?? ""), digest(expected));
}

export function requireBearer(req: Request, expected: string): void {
  if (!bearerMatches(req.headers.get("authorization"), expected)) throw new ServiceError(401, "UNAUTHORIZED", "Missing or invalid admin token.", false);
}
