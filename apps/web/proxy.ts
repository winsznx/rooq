import { NextResponse, type NextRequest } from "next/server";
import { adminAuthEnv } from "@/lib/admin/env";
import { adminError } from "@/lib/admin/respond";
import { adminCookieNames, verifyAdminCookie } from "@/lib/admin/session";
import { appCsp } from "@/lib/csp";
import { THEME_BOOTSTRAP } from "@/lib/theme";

let themeHash: Promise<string> | null = null;

/** No route lives here: underscore folders are private in the App Router, so this always renders the site's 404. */
const ADMIN_NOT_FOUND = "/_rooq/not-found";

function inlineThemeHash(): Promise<string> {
  themeHash ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(THEME_BOOTSTRAP)).then((d) => `sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}`);
  return themeHash;
}

/** Next reads the nonce from this request header and stamps it on every script tag it renders for the page. */
async function withNonceCsp(request: NextRequest, rewriteTo?: URL): Promise<NextResponse> {
  const nonce = btoa(crypto.randomUUID());
  const policy = appCsp(nonce, await inlineThemeHash(), process.env.NODE_ENV !== "production");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const init = { request: { headers } };
  const response = rewriteTo ? NextResponse.rewrite(rewriteTo, init) : NextResponse.next(init);
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

/**
 * First of three session checks (proxy, admin layout and pages, each handler). Signed-out visitors may load /admin itself,
 * where the layout shows sign-in, and the auth endpoints. Every other admin page is a 404 and every data call a 401.
 */
async function adminProxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const env = adminAuthEnv();
  const session = env ? await verifyAdminCookie(env, request.cookies.get(adminCookieNames(env).session)?.value) : null;

  let response: NextResponse;
  if (pathname.startsWith("/admin/api/")) {
    response = session || pathname.startsWith("/admin/api/auth/") ? NextResponse.next() : adminError(401, "UNAUTHORIZED", "Sign in to view admin data.");
  } else if (session || pathname === "/admin") {
    response = await withNonceCsp(request);
  } else {
    response = await withNonceCsp(request, new URL(ADMIN_NOT_FOUND, request.url));
  }
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  return pathname === "/admin" || pathname.startsWith("/admin/") ? adminProxy(request) : withNonceCsp(request);
}

export const config = { matcher: ["/app", "/app/:path*", "/admin", "/admin/:path*"] };
