import { createPublicClient, defineChain, fallback, http, type Chain, type PublicClient, type Transport } from "viem";
import { CHAINS, MAINNET_CHAIN_ID_BLOCKED, getDeployment, type ChainConfig, type Deployment, type EnvironmentId } from "@rooq/config";

/** Every RPC request gives up after this long (API_AND_EVENTS.md: <= 5 s failure path). */
export const RPC_TIMEOUT_MS = 5_000;

export interface ChainContext {
  readonly env: EnvironmentId;
  readonly config: ChainConfig;
  readonly chain: Chain;
  readonly deployment: Deployment;
  readonly client: PublicClient<Transport, Chain>;
  readonly rpcUrls: readonly string[];
}

export function createClient(
  config: ChainConfig,
  rpcUrls: readonly string[],
  batchSize: number,
): { chain: Chain; client: PublicClient<Transport, Chain>; urls: readonly string[] } {
  const urls = rpcUrls.length > 0 ? rpcUrls : config.rpcUrls;
  const first = urls[0];
  if (!first) throw new Error(`No RPC URL configured for ${config.environment}`);
  const chain = defineChain({
    id: config.chainId,
    name: config.name,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: { default: { http: [...urls] } },
  });
  const transports = urls.map((url) =>
    http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 2, batch: { batchSize, wait: 0 } }),
  );
  const transport = transports.length === 1 && transports[0] ? transports[0] : fallback(transports);
  return { chain, client: createPublicClient({ chain, transport }), urls };
}

/**
 * Resolves the environment, refuses Robinhood Chain mainnet and verifies the RPC serves the chain the
 * deployment was recorded on before anything is read or written.
 */
export async function loadChain(env: EnvironmentId, rpcUrls: readonly string[], batchSize = 100): Promise<ChainContext> {
  const config = CHAINS[env];
  const deployment = getDeployment(env);
  if (!deployment) throw new Error(`No deployment recorded for ${env}`);
  const { chain, client, urls } = createClient(config, rpcUrls, batchSize);
  const actual = await client.getChainId();
  if (actual === MAINNET_CHAIN_ID_BLOCKED) throw new Error("Refusing to index Robinhood Chain mainnet");
  if (actual !== config.chainId) throw new Error(`RPC chain id ${actual} does not match ${env} (${config.chainId})`);
  if (actual !== deployment.chainId) throw new Error(`Deployment is for chain ${deployment.chainId}, RPC is ${actual}`);
  return { env, config, chain, deployment, client, rpcUrls: urls };
}
