import { CHAINS, type EnvironmentId } from "@rooq/config";

export const REDUCER_VERSION = 2;
export const SERVICE = "indexer";

export interface IndexerConfig {
  readonly env: EnvironmentId;
  /** One or more RPC URLs (comma separated in RPC_URL). Empty means the chain config default. */
  readonly rpcUrls: readonly string[];
  readonly databaseUrl: string;
  readonly schema: string;
  readonly rangeBlocks: bigint;
  readonly pollMs: number;
  readonly reconcileEveryBlocks: bigint;
  readonly maxLagBlocks: bigint;
  readonly maxReorgDepth: bigint;
  readonly rpcBatchSize: number;
}

export const DEFAULT_DATABASE_URL = "postgres://mac@localhost/rooq_local?host=/tmp";

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return Number(raw);
}

function isEnvironment(value: string): value is EnvironmentId {
  return Object.hasOwn(CHAINS, value);
}

export function parseEnvironment(raw: string | undefined): EnvironmentId {
  const env = raw ?? "local";
  if (!isEnvironment(env)) throw new Error(`Unknown ROOQ_ENV "${env}"`);
  return env;
}

/** Postgres identifiers are interpolated into search_path, so only plain lowercase names are accepted. */
export function parseSchema(raw: string | undefined): string {
  const schema = raw && raw !== "" ? raw : "public";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`DATABASE_SCHEMA "${schema}" is not a plain identifier`);
  return schema;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): IndexerConfig {
  return {
    env: parseEnvironment(source.ROOQ_ENV),
    rpcUrls: (source.RPC_URL ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter((u) => u !== ""),
    databaseUrl: source.DATABASE_URL && source.DATABASE_URL !== "" ? source.DATABASE_URL : DEFAULT_DATABASE_URL,
    schema: parseSchema(source.DATABASE_SCHEMA),
    rangeBlocks: BigInt(positiveInt("INDEXER_RANGE_BLOCKS", source.INDEXER_RANGE_BLOCKS, 2_000)),
    pollMs: positiveInt("INDEXER_POLL_MS", source.INDEXER_POLL_MS, 1_000),
    reconcileEveryBlocks: BigInt(positiveInt("RECONCILE_EVERY_BLOCKS", source.RECONCILE_EVERY_BLOCKS, 20)),
    maxLagBlocks: BigInt(positiveInt("INDEXER_MAX_LAG_BLOCKS", source.INDEXER_MAX_LAG_BLOCKS, 5)),
    maxReorgDepth: BigInt(positiveInt("INDEXER_MAX_REORG_DEPTH", source.INDEXER_MAX_REORG_DEPTH, 1_000)),
    rpcBatchSize: positiveInt("RPC_BATCH_SIZE", source.RPC_BATCH_SIZE, 100),
  };
}
