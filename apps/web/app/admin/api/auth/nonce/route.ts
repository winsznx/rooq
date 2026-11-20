import { generateSiweNonce } from "viem/siwe";
import { adminAuthEnv } from "@/lib/admin/env";
import { adminJson, adminUnavailable } from "@/lib/admin/respond";
import { adminCookieNames, adminCookieOptions, adminSigningKey, nowSeconds } from "@/lib/admin/session";
import { issueNonce, NONCE_TTL_S } from "@/lib/admin/token";

/** Stateless: the nonce travels back in a signed HttpOnly cookie, because Vercel functions share no memory. */
export async function GET(): Promise<Response> {
  const env = adminAuthEnv();
  if (!env) return adminUnavailable();
  const nonce = generateSiweNonce();
  const token = await issueNonce(await adminSigningKey(env), nonce, nowSeconds());
  const response = adminJson({ nonce });
  response.cookies.set(adminCookieNames(env).nonce, token, adminCookieOptions(env, NONCE_TTL_S));
  return response;
}
