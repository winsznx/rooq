import { fileURLToPath } from "node:url";
import { CHAINS, type EnvironmentId } from "@rooq/config";
import type { Hex } from "viem";

export type Env = Record<string, string | undefined>;

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const BASE_PORT = Number(process.env.PRIVATE_BASE_PORT ?? 8710);

/** Services listen on BASE_PORT to BASE_PORT + 7 (8710 by default). PRIVATE_BASE_PORT lets a second stack run beside one. */
export const PORTS = { readApi: BASE_PORT, relayer: BASE_PORT + 1, queue: BASE_PORT + 2, coordinator: BASE_PORT + 3, riskA: BASE_PORT + 4, riskB: BASE_PORT + 5, maker: BASE_PORT + 6, priceRelay: BASE_PORT + 7 } as const;

export function intEnv(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) throw new Error(`${name} must be an integer >= ${min}`);
  return Number(raw);
}

export function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** Reads a secret and removes it from the process environment, so a crash dump or child process cannot see it. */
export function takeSecret(env: Env, name: string): string {
  const value = requireEnv(env, name);
  delete env[name];
  return value;
}

/** A Grumpkin scalar or wallet seed, as decimal or 0x hex. The error names the variable and never echoes it. */
export function takeScalar(env: Env, name: string): bigint {
  const raw = takeSecret(env, name);
  if (!/^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(raw)) throw new Error(`${name} is not a decimal or 0x hex scalar`);
  return BigInt(raw);
}

/** Optional comma-separated scalars, for retired keys kept to read old records (D-24). Removed from the environment like any secret. */
export function takeScalarList(env: Env, name: string): bigint[] {
  const raw = env[name];
  delete env[name];
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((part, i) => {
    const value = part.trim();
    if (!/^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(value)) throw new Error(`${name} entry ${i} is not a decimal or 0x hex scalar`);
    return BigInt(value);
  });
}

export function takePrivateKey(env: Env, name: string): Hex {
  const raw = takeSecret(env, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${name} is not a 32-byte 0x hex key`);
  return raw as Hex;
}

export interface BaseConfig {
  readonly env: EnvironmentId;
  readonly rpcUrl: string;
  readonly deploymentFile: string;
  readonly pollMs: number;
  readonly logRangeBlocks: bigint;
  /** Newest block-hash checkpoints kept for finding a fork point. Beyond them a reorg is handled by a full rebuild. */
  readonly checkpoints: number;
  readonly proverThreads: number;
  readonly allowedOrigins: readonly string[];
  readonly hostname: string;
  /** Set only when exactly one reverse proxy fronts the services on loopback, so X-Forwarded-For names the client. */
  readonly trustProxy: boolean;
}

function environment(raw: string | undefined): EnvironmentId {
  const value = raw ?? "local";
  if (!Object.hasOwn(CHAINS, value)) throw new Error(`Unknown ROOQ_ENV "${value}"`);
  return value as EnvironmentId;
}

export function loadBaseConfig(env: Env = process.env): BaseConfig {
  const environmentId = environment(env.ROOQ_ENV);
  const cfg = CHAINS[environmentId];
  const rpcUrl = env.RPC_URL ?? cfg.rpcUrls[0];
  if (!rpcUrl) throw new Error("No RPC URL configured");
  return {
    env: environmentId,
    rpcUrl,
    deploymentFile: env.PRIVATE_DEPLOYMENT_FILE ?? `${REPO_ROOT}contracts/deployments/privacy-${cfg.chainId}.json`,
    pollMs: intEnv(env, "POLL_MS", 1_000, 50),
    logRangeBlocks: BigInt(intEnv(env, "LOG_RANGE_BLOCKS", 5_000, 1)),
    checkpoints: intEnv(env, "CHECKPOINTS", 8_192, 16),
    proverThreads: intEnv(env, "PROVER_THREADS", 4, 1),
    allowedOrigins: (env.ROOQ_ALLOWED_ORIGINS ?? "http://localhost:3200,http://127.0.0.1:3200").split(",").map((o) => o.trim()).filter((o) => o !== ""),
    hostname: env.BIND_HOST ?? "127.0.0.1",
    trustProxy: env.TRUST_PROXY === "1",
  };
}
