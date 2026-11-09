import { errorBody, ServiceError, toServiceError } from "./errors";
import type { Logger } from "./log";

export interface RequestContext {
  readonly req: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
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

/** Sliding window, in memory only. Entries expire after the window, so client network data never outlives it. */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  allow(key: string, perMinute: number, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.hits.set(key, recent);
    return recent.length <= perMinute;
  }

  prune(now = Date.now()): void {
    for (const [key, times] of this.hits) if (times.every((t) => now - t >= 60_000)) this.hits.delete(key);
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
        if (route.perMinute !== undefined && !limiter.allow(`${route.pattern}|${clientKey(req, srv.requestIP(req)?.address, opts.trustProxy ?? false)}`, route.perMinute)) {
          throw new ServiceError(429, "RATE_LIMITED", "Too many requests. Wait a minute and try again.", true);
        }
        response = await route.handler({ req, url, params });
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
