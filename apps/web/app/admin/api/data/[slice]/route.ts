import { ADMIN_BUCKETS, ADMIN_RANGES } from "@rooq/private-sdk/admin";
import type { NextRequest } from "next/server";
import { isAdminSlice } from "@/lib/admin/api";
import { analyticsEnv } from "@/lib/admin/env";
import { adminError, adminJson } from "@/lib/admin/respond";
import { getAdminSession } from "@/lib/admin/session";

const UPSTREAM_TIMEOUT_MS = 8_000;
const QUERY_ALLOWLIST: Record<string, readonly string[]> = { range: ADMIN_RANGES, bucket: ADMIN_BUCKETS };

/**
 * Same-origin proxy to the analytics service. The proxy already answers 401 without a session; the check repeats
 * here because the proxy is not a security boundary on its own. Only validated range and bucket values travel upstream.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/admin/api/data/[slice]">): Promise<Response> {
  if (!(await getAdminSession())) return adminError(401, "UNAUTHORIZED", "Sign in again to view admin data.");

  const { slice } = await ctx.params;
  if (!isAdminSlice(slice)) return adminError(404, "UNKNOWN_SLICE", `Unknown admin data "${slice.slice(0, 32)}".`);

  const query = new URLSearchParams();
  for (const [name, allowed] of Object.entries(QUERY_ALLOWLIST)) {
    const value = request.nextUrl.searchParams.get(name);
    if (value === null) continue;
    if (!allowed.includes(value)) return adminError(400, "INVALID_REQUEST", `${name} must be one of ${allowed.join(", ")}.`);
    query.set(name, value);
  }

  const upstream = analyticsEnv();
  if (!upstream) return adminError(503, "UNAVAILABLE", "The analytics service is not configured on this deployment.");

  let response: Response;
  try {
    response = await fetch(`${upstream.url}/v1/admin/${slice}${query.size ? `?${query}` : ""}`, {
      headers: { authorization: `Bearer ${upstream.token}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") return adminError(504, "UPSTREAM_TIMEOUT", "The analytics service took too long to answer.", true);
    console.error("rooq admin: analytics service unreachable", { slice, error: error instanceof Error ? error.message : String(error) });
    return adminError(502, "UPSTREAM_ERROR", "Couldn't reach the analytics service.", true);
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    return adminError(429, "RATE_LIMITED", "The analytics service is rate limiting. Try again shortly.", true, retryAfter ? { "retry-after": retryAfter } : {});
  }
  if (await notConfigured(response)) {
    return adminError(503, "NOT_CONFIGURED", `The analytics service doesn't serve ${slice} data on this deployment.`);
  }
  if (!response.ok) {
    // A 401 here means Vercel and the VPS disagree on ADMIN_API_TOKEN. Surfacing it as 401 would read as an expired session.
    console.error("rooq admin: analytics service error", { slice, status: response.status });
    return adminError(502, "UPSTREAM_ERROR", `The analytics service answered ${response.status}.`, response.status >= 500);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    console.error("rooq admin: analytics service sent invalid JSON", { slice, error: error instanceof Error ? error.message : String(error) });
    return adminError(502, "UPSTREAM_ERROR", "The analytics service sent an unreadable answer.", true);
  }
  return adminJson(data);
}

/** A slice whose source the service was never pointed at, such as the mainnet token. Shown as an empty state, not a failure. */
async function notConfigured(response: Response): Promise<boolean> {
  if (response.ok) return false;
  const body: unknown = await response.json().catch(() => null);
  return typeof body === "object" && body !== null && "reasonCode" in body && body.reasonCode === "NOT_CONFIGURED";
}
