import { CHAINS, type EnvironmentId } from "@rooq/config";

export const DEFAULT_DATABASE_URL = "postgres://mac@localhost/rooq_local?host=/tmp";
export const DEFAULT_ALLOWED_ORIGINS = "http://localhost:3200,http://127.0.0.1:3200";

export interface ApiConfig {
  readonly env: EnvironmentId;
  readonly port: number;
  readonly rpcUrls: readonly string[];
  readonly databaseUrl: string;
  readonly schema: string;
  readonly makerUrl: string;
  readonly allowedOrigins: readonly string[];
  /** Indexer heartbeat older than this means the indexer process is down. */
  readonly indexerStaleSeconds: number;
  /** Indexed head more than this many blocks behind the RPC head is "behind". */
  readonly indexerMaxLagBlocks: number;
  readonly spotQuoteTtlSeconds: number;
  /** Per-route failure path. Every outbound call has its own shorter timeout. */
  readonly routeTimeoutMs: number;
}

function int(name: string, raw: string | undefined, fallback: number, min = 0): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return Number(raw);
}

function isEnvironment(value: string): value is EnvironmentId {
  return Object.hasOwn(CHAINS, value);
}

export function loadConfig(source: Record<string, string | undefined> = process.env): ApiConfig {
  const env = source.ROOQ_ENV ?? "local";
  if (!isEnvironment(env)) throw new Error(`Unknown ROOQ_ENV "${env}"`);
  const schema = source.DATABASE_SCHEMA && source.DATABASE_SCHEMA !== "" ? source.DATABASE_SCHEMA : "public";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`DATABASE_SCHEMA "${schema}" is not a plain identifier`);
  return {
    env,
    port: int("API_PORT", source.API_PORT, 8700, 1),
    rpcUrls: (source.RPC_URL ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter((u) => u !== ""),
    databaseUrl: source.DATABASE_URL && source.DATABASE_URL !== "" ? source.DATABASE_URL : DEFAULT_DATABASE_URL,
    schema,
    makerUrl: (source.MAKER_URL ?? "http://127.0.0.1:8701").replace(/\/+$/, ""),
    allowedOrigins: (source.ROOQ_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== ""),
    indexerStaleSeconds: int("INDEXER_STALE_SECONDS", source.INDEXER_STALE_SECONDS, 30, 1),
    indexerMaxLagBlocks: int("INDEXER_MAX_LAG_BLOCKS", source.INDEXER_MAX_LAG_BLOCKS, 5),
    spotQuoteTtlSeconds: int("SPOT_QUOTE_TTL_SECONDS", source.SPOT_QUOTE_TTL_SECONDS, 30, 1),
    routeTimeoutMs: 5_000,
  };
}
