import type { ApiErrorBody } from "@rooq/sdk";
import { API_URL } from "./env";

export class ApiError extends Error {
  readonly body: ApiErrorBody | null;
  readonly status: number;
  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.message ?? `API ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Every API call has an AbortSignal and fails within 5 seconds (API_AND_EVENTS.md). */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "GET", signal });
}

export async function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal });
}

async function request<T>(path: string, init: RequestInit & { signal?: AbortSignal }): Promise<T> {
  const timeout = AbortSignal.timeout(5_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const res = await fetch(`${API_URL}${path}`, { ...init, signal, cache: "no-store" });
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}
