import { NextResponse, type NextRequest } from "next/server";
import { appCsp } from "@/lib/csp";
import { THEME_BOOTSTRAP } from "@/lib/theme";

let themeHash: Promise<string> | null = null;

function inlineThemeHash(): Promise<string> {
  themeHash ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(THEME_BOOTSTRAP)).then((d) => `sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}`);
  return themeHash;
}

/** Next reads the nonce from this request header and stamps it on every script tag it renders for the page. */
export async function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const policy = appCsp(nonce, await inlineThemeHash(), process.env.NODE_ENV !== "production");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = { matcher: ["/app", "/app/:path*"] };
