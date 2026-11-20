"use client";

import { useSearchParams } from "next/navigation";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  ADMIN_RANGES,
  type AdminActions,
  type AdminBucket,
  type AdminFees,
  type AdminFlows,
  type AdminKinds,
  type AdminMarkets,
  type AdminMoney,
  type AdminOperators,
  type AdminOverview,
  type AdminPeople,
  type AdminRange,
  type AdminServices,
  type AdminSliceName,
  type AdminToken,
  type AdminTraffic,
  type AdminVault,
  type AdminWallets,
} from "@rooq/private-sdk/admin";
import { adminDataPath, type AdminErrorBody, type AdminReason, type AdminSliceData } from "./api";

export const DEFAULT_RANGE: AdminRange = "7d";

/** Hourly buckets while a range still fits on screen at that resolution, daily beyond. */
export function bucketFor(range: AdminRange): AdminBucket {
  return range === "24h" || range === "7d" ? "hour" : "day";
}

export function isAdminRange(value: string | null): value is AdminRange {
  return value !== null && (ADMIN_RANGES as readonly string[]).includes(value);
}

/** The range lives in the URL so a view can be shared, reloaded and walked back with the browser. */
export function useAdminRange(): AdminRange {
  const value = useSearchParams().get("range");
  return isAdminRange(value) ? value : DEFAULT_RANGE;
}

/** Testnet is the Rooq protocol itself; mainnet is the $ROOQ token on Robinhood Chain. */
export const ADMIN_NETWORKS = ["testnet", "mainnet"] as const;
export type AdminNetwork = (typeof ADMIN_NETWORKS)[number];
export const DEFAULT_NETWORK: AdminNetwork = "testnet";

export function isAdminNetwork(value: string | null): value is AdminNetwork {
  return value !== null && (ADMIN_NETWORKS as readonly string[]).includes(value);
}

/** Read from `env` in the URL, like the range. */
export function useAdminNetwork(): AdminNetwork {
  const value = useSearchParams().get("env");
  return isAdminNetwork(value) ? value : DEFAULT_NETWORK;
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason: AdminReason | null = null,
  ) {
    super(message);
    this.name = "AdminApiError";
  }

  /** The session cookie expired or was cleared; only signing in again helps. */
  get signedOut(): boolean {
    return this.status === 401;
  }

  /** The service has no source for this slice on this deployment. Nothing to retry or fix from the admin. */
  get notConfigured(): boolean {
    return this.reason === "NOT_CONFIGURED";
  }
}

function errorBody(body: unknown): { message: string | null; reason: AdminReason | null } {
  if (typeof body !== "object" || body === null) return { message: null, reason: null };
  const { message, reasonCode } = body as Partial<AdminErrorBody>;
  return { message: typeof message === "string" && message.length > 0 ? message : null, reason: typeof reasonCode === "string" ? reasonCode : null };
}

async function adminGet<T>(slice: AdminSliceName, params: Record<string, string>, signal: AbortSignal): Promise<T> {
  const query = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`${adminDataPath(slice)}${query ? `?${query}` : ""}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: "no-store", credentials: "same-origin" });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AdminApiError(0, "The admin API can't be reached. Check the connection and try again.");
  }
  if (!res.ok) {
    const { message, reason } = errorBody(await res.json().catch(() => null));
    throw new AdminApiError(res.status, message ?? `The admin API answered ${res.status}.`, reason);
  }
  return (await res.json()) as T;
}

/** A dropped session or a refused request won't change on retry; a flaky upstream might. */
function retryOnce(count: number, error: AdminApiError): boolean {
  return count < 1 && !error.notConfigured && (error.status === 0 || error.status >= 500);
}

const SLOW = 60_000;
const MEDIUM = 30_000;
const FAST = 15_000;

/** `bucketed` slices return series, so their bucket follows the range. */
function useSlice<S extends AdminSliceName>(slice: S, range: AdminRange | null, bucketed: boolean, refetchInterval: number): UseQueryResult<AdminSliceData[S], AdminApiError> {
  const params: Record<string, string> = {};
  if (range) params.range = range;
  if (range && bucketed) params.bucket = bucketFor(range);
  return useQuery({
    queryKey: ["admin", slice, ...Object.values(params)],
    queryFn: ({ signal }) => adminGet<AdminSliceData[S]>(slice, params, signal),
    refetchInterval,
    retry: retryOnce,
  });
}

export function useAdminOverview(range: AdminRange): UseQueryResult<AdminOverview, AdminApiError> {
  return useSlice("overview", range, false, MEDIUM);
}

export function useAdminActions(range: AdminRange): UseQueryResult<AdminActions, AdminApiError> {
  return useSlice("actions", range, true, SLOW);
}

export function useAdminFlows(range: AdminRange): UseQueryResult<AdminFlows, AdminApiError> {
  return useSlice("flows", range, true, SLOW);
}

export function useAdminWallets(range: AdminRange): UseQueryResult<AdminWallets, AdminApiError> {
  return useSlice("wallets", range, true, SLOW);
}

export function useAdminTraffic(range: AdminRange): UseQueryResult<AdminTraffic, AdminApiError> {
  return useSlice("traffic", range, true, SLOW);
}

export function useAdminOperators(range: AdminRange): UseQueryResult<AdminOperators, AdminApiError> {
  return useSlice("operators", range, false, SLOW);
}

export function useAdminMarkets(range: AdminRange): UseQueryResult<AdminMarkets, AdminApiError> {
  return useSlice("markets", range, false, SLOW);
}

export function useAdminServices(): UseQueryResult<AdminServices, AdminApiError> {
  return useSlice("services", null, false, FAST);
}

export function useAdminMoney(range: AdminRange): UseQueryResult<AdminMoney, AdminApiError> {
  return useSlice("money", range, true, SLOW);
}

/** Balances read now; the range doesn't apply. */
export function useAdminVault(): UseQueryResult<AdminVault, AdminApiError> {
  return useSlice("vault", null, false, SLOW);
}

export function useAdminFees(range: AdminRange): UseQueryResult<AdminFees, AdminApiError> {
  return useSlice("fees", range, true, SLOW);
}

export function useAdminPeople(range: AdminRange): UseQueryResult<AdminPeople, AdminApiError> {
  return useSlice("people", range, true, SLOW);
}

export function useAdminKinds(range: AdminRange): UseQueryResult<AdminKinds, AdminApiError> {
  return useSlice("kinds", range, true, SLOW);
}

export function useAdminToken(range: AdminRange): UseQueryResult<AdminToken, AdminApiError> {
  return useSlice("token", range, true, MEDIUM);
}

