import { dirname, join } from "node:path";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { intEnv, type Env } from "./config";

/** $ROOQ on Robinhood Chain mainnet: the Pons launch, its Uniswap v4 pool and the creator's fee escrow. */
export const TOKEN_CHAIN_ID = 4663;

/** The public node refuses requests carrying a default client User-Agent. */
export const TOKEN_USER_AGENT = "rooq-analytics/1";

const DEFAULTS = {
  token: "0x56f316047b358c0d3c04540ff47ff4373df48ec0",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  poolId: "0x921fdaeed6ddc20f4bf05401a936721f983af39c3558df7f68ea29bc40036db2",
  feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  creator: "0xd91d50dC647555D9283C2f15E1849d99753f8AAA",
  startBlock: 110_991_659,
  /** 0.7% hook share plus the 3% creator tax. */
  creatorRateBps: 370,
} as const;

export interface TokenConfig {
  readonly rpcUrl: string;
  readonly token: Address;
  readonly poolManager: Address;
  readonly poolId: Hex;
  readonly feeEscrow: Address;
  readonly creator: Address;
  readonly startBlock: bigint;
  readonly creatorRateBps: number;
  /** Where ETH/USD comes from: CoinGecko simple price by default; a Pons launch JSON with `quoteUsd` also works. */
  readonly priceUrl: string;
  readonly dbPath: string;
  /** Blocks are about a tenth of a second, so this is roughly a minute behind the head. */
  readonly finality: bigint;
  readonly maxSpan: bigint;
  readonly minSpan: bigint;
  readonly concurrency: number;
  readonly budgetMs: number;
  readonly intervalMs: number;
  /** Live reads (pool state, supply, escrow, ETH/USD) are cached this long. */
  readonly liveTtlMs: number;
}

function addressEnv(env: Env, name: string, fallback: string): Address {
  const raw = env[name]?.trim() || fallback;
  if (!isAddress(raw, { strict: false })) throw new Error(`${name} is not an address`);
  return getAddress(raw);
}

/** Null unless ROOQ_TOKEN_RPC_URL is set: the slice is off by default. Every address can be overridden by env. */
export function loadTokenConfig(env: Env, analyticsDbPath: string): TokenConfig | null {
  const rpcUrl = env.ROOQ_TOKEN_RPC_URL?.trim() ?? "";
  if (rpcUrl === "") return null;
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error("ROOQ_TOKEN_RPC_URL must be an http(s) URL");
  const poolId = env.ROOQ_TOKEN_POOL_ID?.trim() || DEFAULTS.poolId;
  if (!isHex(poolId) || poolId.length !== 66) throw new Error("ROOQ_TOKEN_POOL_ID must be a 32-byte 0x hex pool id");
  const token = addressEnv(env, "ROOQ_TOKEN_ADDRESS", DEFAULTS.token);
  return {
    rpcUrl,
    token,
    poolManager: addressEnv(env, "ROOQ_TOKEN_POOL_MANAGER", DEFAULTS.poolManager),
    poolId: poolId.toLowerCase() as Hex,
    feeEscrow: addressEnv(env, "ROOQ_TOKEN_FEE_ESCROW", DEFAULTS.feeEscrow),
    creator: addressEnv(env, "ROOQ_TOKEN_CREATOR", DEFAULTS.creator),
    startBlock: BigInt(intEnv(env, "ROOQ_TOKEN_START_BLOCK", DEFAULTS.startBlock, 0)),
    creatorRateBps: intEnv(env, "ROOQ_TOKEN_CREATOR_RATE_BPS", DEFAULTS.creatorRateBps, 0),
    priceUrl: env.ROOQ_TOKEN_PRICE_URL?.trim() || "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    dbPath: env.ROOQ_TOKEN_DB_PATH?.trim() || (analyticsDbPath === ":memory:" ? ":memory:" : join(dirname(analyticsDbPath), "token.db")),
    finality: BigInt(intEnv(env, "ROOQ_TOKEN_FINALITY_BLOCKS", 600, 1)),
    maxSpan: BigInt(intEnv(env, "ROOQ_TOKEN_LOG_RANGE_BLOCKS", 500_000, 1)),
    minSpan: BigInt(intEnv(env, "ROOQ_TOKEN_MIN_LOG_RANGE_BLOCKS", 5_000, 1)),
    concurrency: intEnv(env, "ROOQ_TOKEN_RPC_CONCURRENCY", 4, 1),
    budgetMs: intEnv(env, "ROOQ_TOKEN_TICK_BUDGET_MS", 10_000, 1_000),
    intervalMs: intEnv(env, "ROOQ_TOKEN_INDEX_INTERVAL_MS", 15_000, 0),
    liveTtlMs: intEnv(env, "ROOQ_TOKEN_LIVE_TTL_MS", 60_000, 1_000),
  };
}
