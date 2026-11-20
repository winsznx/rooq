import { errorBody, ServiceError, toServiceError } from "./errors";
import type { Logger } from "./log";

export interface RequestContext {
  readonly req: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  /** The key this request is rate limited under (see `clientKey`). Set by the server; absent when a test calls a handler directly. */
  readonly client?: string;
}

export interface Route {
  readonly method: "GET" | "POST";
  /** Path with `:name` segments. Only this pattern is ever logged, never the concrete path. */
  readonly pattern: string;
  /** Requests per minute per client; omit to leave unlimited (health and status). */
  readonly perMinute?: number;
  handler(ctx: RequestContext): Promise<Response> | Response;
}

export function stringify(body: unknown): string {
  return JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

export function json(body: unknown, status = 200): Response {
  return new Response(stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

interface Window {
  /** Accepted hits in arrival order; entries before `head` have expired and wait for compaction. */
  times: number[];
  head: number;
}

/**
 * Sliding window, in memory only. Entries expire after the window, so client network data never outlives it. Only
 * accepted hits are stored, so a key holds at most its limit and a flood of refused requests costs O(1) each.
 */
export class RateLimiter {
  private readonly hits = new Map<string, Window>();

  constructor(private readonly windowMs = 60_000) {}

  allow(key: string, perWindow: number, now = Date.now()): boolean {
    return this.allowAll([key], perWindow, now);
  }

  /** Charges one hit to every key, or to none when any of them is at its limit. */
  allowAll(keys: readonly string[], perWindow: number, now = Date.now()): boolean {
    return this.allowEach(keys.map((key) => ({ key, limit: perWindow })), now) === null;
  }

  /**
   * Like allowAll with a limit per key, charging `units` hits to each key at once. Returns the first key without room for
   * all of them, or null when every key was charged.
   */
  allowEach(entries: readonly { readonly key: string; readonly limit: number }[], now = Date.now(), units = 1): string | null {
    const unique = new Map<string, number>();
    for (const { key, limit } of entries) unique.set(key, Math.min(limit, unique.get(key) ?? limit));
    const windows: Window[] = [];
    for (const [key, limit] of unique) {
      const w = this.window(key, now);
      if (w.times.length - w.head + units > limit) return key;
      windows.push(w);
    }
    for (const w of windows) for (let i = 0; i < units; i++) w.times.push(now);
    return null;
  }

  /** Takes back the latest `units` hits of each key, for a charge whose work never happened. */
  refund(keys: readonly string[], units = 1): void {
    for (const key of new Set(keys)) {
      const w = this.hits.get(key);
      if (!w) continue;
      w.times.length = Math.max(w.head, w.times.length - units);
    }
  }

  /** Hits currently held for a key, for tests and health. */
  size(key: string, now = Date.now()): number {
    const w = this.hits.get(key);
    if (!w) return 0;
    this.expire(w, now);
    return w.times.length - w.head;
  }

  prune(now = Date.now()): void {
    for (const [key, w] of this.hits) {
      this.expire(w, now);
      if (w.times.length === w.head) this.hits.delete(key);
    }
  }

  private window(key: string, now: number): Window {
    let w = this.hits.get(key);
    if (!w) {
      w = { times: [], head: 0 };
      this.hits.set(key, w);
    }
    this.expire(w, now);
    return w;
  }

  private expire(w: Window, now: number): void {
    while (w.head < w.times.length && now - w.times[w.head]! >= this.windowMs) w.head++;
    if (w.head > 32 && w.head * 2 > w.times.length) {
      w.times = w.times.slice(w.head);
      w.head = 0;
    }
  }
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(":")) params[w.slice(1)] = decodeURIComponent(g);
    else if (w !== g) return null;
  }
  return params;
}

export interface ServerOptions {
  readonly name: string;
  readonly port: number;
  readonly hostname: string;
  readonly allowedOrigins: readonly string[];
  readonly routes: readonly Route[];
  readonly log: Logger;
  readonly trustProxy?: boolean;
}

function cors(origin: string | null, allowed: readonly string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600", vary: "origin" };
}

/** Behind the one trusted proxy the socket peer is always the proxy, so limits key on the entry the proxy appended last. */
export function clientKey(req: Request, peer: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return peer ?? "unknown";
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export function startHttpServer(opts: ServerOptions): { stop(): void } {
  const limiter = new RateLimiter();
  const pruner = setInterval(() => limiter.prune(), 30_000);
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    idleTimeout: 60,
    maxRequestBodySize: 1024 * 1024,
    async fetch(req, srv) {
      const started = performance.now();
      const url = new URL(req.url);
      const corsHeaders = cors(req.headers.get("origin"), opts.allowedOrigins);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
      const requestId = crypto.randomUUID();
      let pattern = "unmatched";
      let response: Response;
      try {
        let route: Route | undefined;
        let params: Record<string, string> | null = null;
        let pathMatched = false;
        for (const r of opts.routes) {
          const p = matchPattern(r.pattern, url.pathname);
          if (!p) continue;
          pathMatched = true;
          if (r.method === req.method) {
            route = r;
            params = p;
            break;
          }
        }
        if (!route || !params) throw new ServiceError(pathMatched ? 405 : 404, pathMatched ? "METHOD_NOT_ALLOWED" : "NOT_FOUND", pathMatched ? "Method not allowed." : "No such route.", false);
        pattern = route.pattern;
        const client = clientKey(req, srv.requestIP(req)?.address, opts.trustProxy ?? false);
        if (route.perMinute !== undefined && !limiter.allow(`${route.pattern}|${client}`, route.perMinute)) {
          throw new ServiceError(429, "RATE_LIMITED", "Too many requests. Wait a minute and try again.", true);
        }
        response = await route.handler({ req, url, params, client });
      } catch (error) {
        const service = toServiceError(error);
        if (service.statusCode >= 500) opts.log.error("request_failed", error, { route: pattern, reasonCode: service.reasonCode });
        response = json(errorBody(service, requestId), service.statusCode);
      }
      opts.log.debug("request", { route: pattern, method: req.method, status: response.status, ms: Math.round(performance.now() - started) });
      return withHeaders(response, corsHeaders);
    },
    error(error) {
      opts.log.error("server_error", error);
      return json(errorBody(new ServiceError(500, "INTERNAL", "Internal error.", true), crypto.randomUUID()), 500);
    },
  });
  return {
    stop(): void {
      clearInterval(pruner);
      server.stop(true);
    },
  };
}

export async function readJson(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ServiceError(413, "BODY_TOO_LARGE", `Request body is larger than ${maxBytes} bytes.`, false);
  const text = await req.text();
  if (text.length > maxBytes) throw new ServiceError(413, "BODY_TOO_LARGE", `Request body is larger than ${maxBytes} bytes.`, false);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServiceError(400, "INVALID_JSON", "Request body is not valid JSON.", false);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ServiceError(400, "INVALID_REQUEST", "Request body must be a JSON object.", false);
  return { ...parsed };
}

export function limitParam(url: URL, fallback: number, max: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new ServiceError(400, "INVALID_REQUEST", `limit must be an integer between 1 and ${max}.`, false);
  return Number(raw);
}

export function fromParam(url: URL, name = "from"): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return 0;
  if (!/^\d{1,15}$/.test(raw)) throw new ServiceError(400, "INVALID_REQUEST", `${name} must be a non-negative integer.`, false);
  return Number(raw);
}
