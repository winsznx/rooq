import { NextResponse, type NextRequest } from "next/server";
import { adminAuthEnv } from "@/lib/admin/env";
import { adminError } from "@/lib/admin/respond";
import { adminCookieNames, adminCookieOptions } from "@/lib/admin/session";

export function POST(request: NextRequest): Response {
  const env = adminAuthEnv();
  if (!env) return new NextResponse(null, { status: 204 });
  if (request.headers.get("origin") !== env.origin) return adminError(403, "FORBIDDEN_ORIGIN", "Sign out from the Rooq site.");
  const response = new NextResponse(null, { status: 204, headers: { "cache-control": "private, no-store" } });
  response.cookies.set(adminCookieNames(env).session, "", adminCookieOptions(env, 0));
  return response;
}
