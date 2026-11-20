import "server-only";
import { NextResponse } from "next/server";
import type { AdminErrorBody, AdminReason } from "./api";

const HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" } as const;

export function adminJson<T>(body: T, status = 200): NextResponse<T> {
  return NextResponse.json(body, { status, headers: HEADERS });
}

export function adminError(statusCode: number, reasonCode: AdminReason, message: string, canRetry = false, headers: Record<string, string> = {}): NextResponse<AdminErrorBody> {
  return NextResponse.json({ statusCode, reasonCode, message, canRetry }, { status: statusCode, headers: { ...HEADERS, ...headers } });
}

export function adminUnavailable(): NextResponse<AdminErrorBody> {
  return adminError(503, "UNAVAILABLE", "Admin is not configured on this deployment.");
}
