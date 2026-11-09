import { createPublicClient, defineChain, fallback, http, type Chain, type PublicClient, type Transport } from "viem";
import { CHAINS, MAINNET_CHAIN_ID_BLOCKED, getDeployment, type ChainConfig, type Deployment, type EnvironmentId } from "@rooq/config";
import type { BlockAnchor } from "@rooq/sdk";
import { ApiError, networkDelayed } from "./errors";

/** Each RPC HTTP request (a batch of reads) gives up after this long; routes add a 5 s ceiling. */
export const RPC_TIMEOUT_MS = 4_000;

export interface ChainHandle {
  readonly env: EnvironmentId;
  readonly config: ChainConfig;
  readonly chain: Chain;
  readonly deployment: Deployment | null;
  readonly client: PublicClient<Transport, Chain>;
  /** Resolves once the RPC was seen serving the configured chain id; rejects on a mismatch. */
  verified(): Promise<void>;
}

export interface Anchored {
  readonly anchor: BlockAnchor;
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
}

export function createChain(env: EnvironmentId, rpcUrls: readonly string[]): ChainHandle {
  const config = CHAINS[env];
  const urls = rpcUrls.length > 0 ? rpcUrls : config.rpcUrls;
  if (urls.length === 0) throw new Error(`No RPC URL for ${env}`);
  const chain = defineChain({ id: config.chainId, name: config.name, nativeCurrency: config.nativeCurrency, rpcUrls: { default: { http: [...urls] } } });
  const transports = urls.map((u) => http(u, { timeout: RPC_TIMEOUT_MS, retryCount: 0, batch: { batchSize: 200, wait: 0 } }));
  const transport = transports.length === 1 && transports[0] ? transports[0] : fallback(transports);
  const client = createPublicClient({ chain, transport, cacheTime: 0 });
  const deployment = getDeployment(env);

  let verifiedOnce: Promise<void> | null = null;
  const verify = async (): Promise<void> => {
    const actual = await client.getChainId();
    if (actual === MAINNET_CHAIN_ID_BLOCKED || actual !== config.chainId) {
      throw new ApiError(503, "CHAIN_MISMATCH", `The RPC serves chain ${actual}, expected ${config.chainId}.`, false);
    }
  };
  return {
    env,
    config,
    chain,
    deployment,
    client,
    verified: () => {
      verifiedOnce ??= verify().catch((error: unknown) => {
        verifiedOnce = null;
        throw error;
      });
      return verifiedOnce;
    },
  };
}

export function requireDeployment(handle: ChainHandle): Deployment {
  if (!handle.deployment) throw new ApiError(503, "INTERNAL", `Rooq is not deployed on ${handle.config.name}.`, false);
  return handle.deployment;
}

/** Latest block: every read for one response is pinned to it, so the response is one consistent snapshot. */
export async function anchorBlock(handle: ChainHandle): Promise<Anchored> {
  await handle.verified();
  const block = await handle.client.getBlock({ blockTag: "latest" });
  if (block.number === null) throw networkDelayed("The RPC returned a pending block as latest.");
  return {
    anchor: { chainId: handle.config.chainId, blockNumber: block.number.toString(), blockTimestamp: Number(block.timestamp) },
    blockNumber: block.number,
    timestamp: block.timestamp,
  };
}
