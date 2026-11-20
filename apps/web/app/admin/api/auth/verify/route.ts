import { verifyMessage } from "viem";
import type { NextRequest, NextResponse } from "next/server";
import type { AdminReason, AdminSignInResult } from "@/lib/admin/api";
import { adminAuthEnv } from "@/lib/admin/env";
import { adminError, adminJson } from "@/lib/admin/respond";
import { adminCookieNames, adminCookieOptions, adminSigningKey, nowSeconds } from "@/lib/admin/session";
import { ADMIN_SIWE_MAX_LENGTH, checkAdminSiwe, type AdminSiweRejection } from "@/lib/admin/siwe";
import { issueSession, readNonce, SESSION_TTL_S } from "@/lib/admin/token";
import { CHAIN } from "@/lib/env";

const MAX_BODY_BYTES = 16_384;
/**
 * A 65-byte ECDSA signature. The owner wallets are EOAs, so the signature is checked by local ecrecover: an
 * unauthenticated caller can't make this endpoint spend an RPC call, and smart-account (ERC-1271, ERC-6492) signatures
 * are refused by design.
 */
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

const REJECTIONS: Record<AdminSiweRejection, { reason: AdminReason; message: string; canRetry: boolean }> = {
  malformed: { reason: "INVALID_MESSAGE", message: "That sign-in message isn't one Rooq issued.", canRetry: false },
  wrong_site: { reason: "INVALID_MESSAGE", message: "That sign-in message is for a different site.", canRetry: false },
  wrong_chain: { reason: "INVALID_MESSAGE", message: "That sign-in message is for a different network.", canRetry: false },
  wrong_nonce: { reason: "NONCE_EXPIRED", message: "That sign-in request was replaced by a newer one. Try again.", canRetry: true },
  expired: { reason: "NONCE_EXPIRED", message: "That sign-in request expired. Try again.", canRetry: true },
};

/**
 * Exchanges a signed EIP-4361 message for a 12 hour session cookie. The nonce is stateless, so single use holds only
 * for a browser that honors the cleared nonce cookie: a client that keeps the cookie and the signature could replay
 * them until the nonce expires (NONCE_TTL_S). Both are needed, and the cookie is HttpOnly.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const env = adminAuthEnv();
  if (!env) return adminError(503, "UNAVAILABLE", "Admin is not configured on this deployment.");
  if (request.headers.get("origin") !== env.origin) return adminError(403, "FORBIDDEN_ORIGIN", "Sign in from the Rooq site.");

  const names = adminCookieNames(env);
  const finish = <T>(response: NextResponse<T>): NextResponse<T> => {
    response.cookies.set(names.nonce, "", adminCookieOptions(env, 0));
    return response;
  };

  const body = await readBody(request);
  if (!body) return finish(adminError(400, "INVALID_REQUEST", "Send a JSON body with the signed message and its signature."));

  const key = await adminSigningKey(env);
  const now = nowSeconds();
  const cookieNonce = await readNonce(key, request.cookies.get(names.nonce)?.value ?? "", now);
  if (!cookieNonce) return finish(adminError(401, "NONCE_EXPIRED", "That sign-in request expired. Try again.", true));

  const check = checkAdminSiwe(body.message, { origin: env.origin, chainId: CHAIN.id, nonce: cookieNonce, now: new Date(now * 1000) });
  if (!check.ok) {
    const rejection = REJECTIONS[check.reason];
    return finish(adminError(401, rejection.reason, rejection.message, rejection.canRetry));
  }

  if (!(await signedBy(check.address, body.message, body.signature))) return finish(adminError(401, "INVALID_SIGNATURE", "The signature doesn't match the wallet in the message."));
  if (!env.addresses.has(check.address.toLowerCase())) return finish(adminError(403, "NOT_ADMIN", "This wallet isn't an admin."));

  const { token, session } = await issueSession(key, check.address, now);
  const response = adminJson<AdminSignInResult>({ address: session.address, exp: session.exp });
  response.cookies.set(names.session, token, adminCookieOptions(env, SESSION_TTL_S));
  return finish(response);
}

/** viem throws on a signature that can't be recovered (bad v, s out of range); that is a wrong signature, not an outage. */
async function signedBy(address: `0x${string}`, message: string, signature: `0x${string}`): Promise<boolean> {
  try {
    return await verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}

async function readBody(request: NextRequest): Promise<{ message: string; signature: `0x${string}` } | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { message, signature } = parsed as Record<string, unknown>;
  if (typeof message !== "string" || message.length > ADMIN_SIWE_MAX_LENGTH) return null;
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return null;
  return { message, signature: signature as `0x${string}` };
}
