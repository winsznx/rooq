import { initCrypto } from "@rooq/private-sdk";
import { ChainContext, sleep } from "./chain";
import { intEnv, loadBaseConfig, type BaseConfig, type Env } from "./config";
import { errorMessage, createLogger, type Logger } from "./log";
import { Ledger } from "./ledger";
import { json, startHttpServer, type Route } from "./http";

export interface Liveness {
  /** Counts of work waiting. Zero everywhere means the service is keeping up. */
  backlog: Record<string, number>;
  /** Monotone counters: actions done, races lost, re-proofs. */
  counters: Record<string, number>;
  /** Why work is held back right now, if anything is. */
  blocked: string | null;
  /** Service-specific fields safe to publish. */
  details: Record<string, unknown>;
}

export interface ServiceContext {
  readonly name: string;
  readonly config: BaseConfig;
  readonly chain: ChainContext;
  readonly ledger: Ledger;
  readonly log: Logger;
  readonly liveness: Liveness;
  recordAction(action: string, tx?: string): void;
  bump(counter: string, by?: number): void;
}

export interface ServiceDefinition {
  readonly name: string;
  readonly port: number;
  /** Runs once after the chain context opens, before the first tick; the place to load keys and check them. */
  init(ctx: ServiceContext): Promise<ServiceHandlers> | ServiceHandlers;
}

export interface ServiceHandlers {
  readonly routes?: readonly Route[];
  /** One round of work after the ledger has been synced. */
  tick?(): Promise<void>;
  shutdown?(): Promise<void>;
}

const startedAt = Date.now();

function bodyOf(ctx: ServiceContext, state: LoopState): { body: Record<string, unknown>; ok: boolean } {
  const lastTickAgeMs = state.lastTickAt ? Date.now() - state.lastTickAt : null;
  const synced = ctx.ledger.syncedBlock;
  const lag = synced === null ? null : ctx.ledger.head - synced;
  const ok = state.lastTickAt !== null && lastTickAgeMs !== null && lastTickAgeMs < state.staleAfterMs && state.lastError === null;
  return {
    ok,
    body: {
      service: ctx.name,
      status: ok ? "ok" : state.lastTickAt === null ? "starting" : "degraded",
      pid: process.pid,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      chainId: ctx.chain.chain.id,
      lastBlockSeen: ctx.ledger.head,
      syncedBlock: synced,
      lagBlocks: lag,
      lastTickAgeMs,
      lastAction: state.lastAction,
      lastError: state.lastError,
      reorgs: ctx.ledger.reorgs,
      deepestReorg: ctx.ledger.deepestReorg,
      fullRebuilds: ctx.ledger.fullRebuilds,
      processed: ctx.ledger.processed,
      queueLength: ctx.ledger.queueLength,
      backlog: ctx.liveness.backlog,
      counters: ctx.liveness.counters,
      blocked: ctx.liveness.blocked,
      ...ctx.liveness.details,
    },
  };
}

interface LoopState {
  lastTickAt: number | null;
  lastAction: { action: string; at: string; tx?: string } | null;
  lastError: { message: string; at: string } | null;
  staleAfterMs: number;
}

/**
 * Process shell shared by every service: opens the chain (retrying until the RPC answers), serves health, and runs a
 * single sync-then-work loop. Crypto loads first; every service has a tree and hashes.
 */
export async function runService(def: ServiceDefinition, env: Env = process.env): Promise<void> {
  const log = createLogger(def.name);
  const config = loadBaseConfig(env);
  await initCrypto();
  let chain: ChainContext | null = null;
  while (!chain) {
    try {
      chain = await ChainContext.open(config);
    } catch (error) {
      if (error instanceof Error && /Refusing|does not match|Deployment file|No markets/.test(error.message)) throw error;
      log.warn("chain_unavailable", { message: errorMessage(error) });
      await sleep(2_000);
    }
  }
  const ledger = new Ledger(chain, log);
  const liveness: Liveness = { backlog: {}, counters: {}, blocked: null, details: {} };
  const state: LoopState = { lastTickAt: null, lastAction: null, lastError: null, staleAfterMs: intEnv(env, "HEALTH_STALE_MS", 60_000, 1_000) };
  const ctx: ServiceContext = {
    name: def.name, config, chain, ledger, log, liveness,
    recordAction(action, tx) {
      state.lastAction = { action, at: new Date().toISOString(), ...(tx ? { tx } : {}) };
    },
    bump(counter, by = 1) {
      liveness.counters[counter] = (liveness.counters[counter] ?? 0) + by;
    },
  };

  const handlers = await def.init(ctx);
  const health: Route = {
    method: "GET",
    pattern: "/health",
    handler: () => {
      const { body, ok } = bodyOf(ctx, state);
      return json(body, ok ? 200 : 503);
    },
  };
  const server = startHttpServer({ name: def.name, port: def.port, hostname: config.hostname, allowedOrigins: config.allowedOrigins, routes: [health, ...(handlers.routes ?? [])], log, trustProxy: config.trustProxy });
  log.info("service_started", { port: def.port, chainId: chain.chain.id, pollMs: config.pollMs });

  let running = true;
  const stop = (signal: string): void => {
    if (!running) return;
    running = false;
    log.info("service_stopping", { signal });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  while (running) {
    try {
      await chain.refreshKeys();
      await ledger.sync();
      await chain.syncCreatedMarkets(ledger.createdMarkets.map((m) => m.market));
      await handlers.tick?.();
      state.lastTickAt = Date.now();
      state.lastError = null;
    } catch (error) {
      state.lastError = { message: errorMessage(error), at: new Date().toISOString() };
      log.error("tick_failed", error);
    }
    if (running) await sleep(config.pollMs);
  }
  await handlers.shutdown?.();
  server.stop();
  process.exit(0);
}
