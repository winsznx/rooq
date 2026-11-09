import pkg from "../package.json";
import { createChain } from "./chain";
import { loadConfig } from "./config";
import { connectDb } from "./db";
import { ApiError, errorBody, notFound, toApiError } from "./errors";
import { RateLimiter, corsHeaders, errorResponse, json, withDeadline } from "./http";
import { log, logError } from "./log";
import { TokenCache } from "./reads";
import { matchRoute, type Services } from "./routes";

const cfg = loadConfig();
const chain = createChain(cfg.env, cfg.rpcUrls);
const sql = connectDb(cfg.databaseUrl, cfg.schema);
const svc: Services = { cfg, chain, sql, tokens: new TokenCache(chain), limiter: new RateLimiter(120, 60_000), version: pkg.version };

try {
  await chain.verified();
  log("chain_verified", { env: cfg.env, chainId: chain.config.chainId });
} catch (error) {
  if (error instanceof ApiError && error.reasonCode === "CHAIN_MISMATCH") {
    logError("chain_mismatch_refusing_to_start", error);
    process.exit(1);
  }
  logError("chain_unreachable_at_start", error, { note: "chain routes return NETWORK_DELAYED until the RPC answers" });
}

const server = Bun.serve({
  port: cfg.port,
  idleTimeout: 30,
  async fetch(req, srv) {
    const started = performance.now();
    const url = new URL(req.url);
    const cors = corsHeaders(req.headers.get("origin"), cfg.allowedOrigins);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const requestId = crypto.randomUUID();
    const match = matchRoute(req.method, url.pathname);
    let response: Response;
    if (!match.route) {
      response = errorResponse(match.methodMismatch ? new ApiError(405, "INVALID_REQUEST", "Method not allowed.", false) : notFound("No such route."), cors, requestId);
    } else {
      const ctx = { req, url, params: match.params, cors, ip: srv.requestIP(req)?.address ?? "unknown", server: srv, svc };
      try {
        response = match.route.streaming ? await match.route.handler(ctx) : await withDeadline(match.route.handler(ctx), cfg.routeTimeoutMs);
      } catch (error) {
        const api = toApiError(error);
        if (api.statusCode >= 500) logError("request_failed", error, { requestId, method: req.method, path: url.pathname, reasonCode: api.reasonCode });
        response = errorResponse(api, cors, requestId);
      }
    }
    log("request", { method: req.method, path: url.pathname, status: response.status, ms: Math.round(performance.now() - started) });
    return response;
  },
  error(error) {
    logError("server_error", error);
    return json(errorBody(new ApiError(500, "INTERNAL", "Internal error.", true)), 500, {});
  },
});

log("api_listening", { port: server.port, env: cfg.env, chainId: chain.config.chainId, schema: cfg.schema, maker: cfg.makerUrl, origins: cfg.allowedOrigins });

const shutdown = async (signal: string) => {
  log("api_stopping", { signal });
  await server.stop();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
