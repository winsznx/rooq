import { getAddress, isAddress, type Address, type Hex } from "viem";
import { DeadlineError, badRequest, errorBody, type ApiError } from "./errors";

/** Serialises bigints as decimal strings; a stray bigint must never become a float or a crash. */
export function stringify(body: unknown): string {
  return JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

/** CORS headers only for exactly-listed origins; anything else gets no CORS grant at all. */
export function corsHeaders(origin: string | null, allowed: readonly string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,last-event-id",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

export function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors },
  });
}

export function errorResponse(error: ApiError, cors: Record<string, string>, requestId?: string): Response {
  return json(errorBody(error, requestId), error.statusCode, cors);
}

export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

const MAX_BODY_BYTES = 16 * 1024;

export async function readBodyText(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw badRequest(`Request body is larger than ${MAX_BODY_BYTES} bytes.`);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw badRequest(`Request body is larger than ${MAX_BODY_BYTES} bytes.`);
  return text;
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const text = await readBodyText(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw badRequest("Request body is not valid JSON.", { parser: error instanceof Error ? error.message : String(error) });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw badRequest("Request body must be a JSON object.");
  return { ...parsed };
}

export function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw badRequest(`${field} must be a 20-byte hex address.`);
  return getAddress(value);
}

export function parseBytes32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw badRequest(`${field} must be a 32-byte hex string.`);
  return `0x${value.slice(2).toLowerCase()}`;
}

const UINT256_MAX = 2n ** 256n - 1n;

export function parseUint(value: unknown, field: string, opts: { min?: bigint; max?: bigint } = {}): bigint {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) throw badRequest(`${field} must be a non-negative integer decimal string.`);
  const n = BigInt(value);
  if (n > (opts.max ?? UINT256_MAX) || n < (opts.min ?? 0n)) throw badRequest(`${field} is out of range.`);
  return n;
}

export function parseSmallInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw badRequest(`limit must be an integer between 1 and ${max}.`);
  return Number(raw);
}

/** Fixed-window limiter per key. In memory: it bounds abuse of one process, not a fleet. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, times] of this.hits) if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    return recent.length <= this.limit;
  }
}
