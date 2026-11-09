import { defineChain, type Chain } from "viem";
import { CHAINS, explorerAddressUrl, explorerTxUrl, getDeployment, type ChainConfig, type Deployment, type EnvironmentId } from "@rooq/config";

function readEnv(): EnvironmentId {
  const value = process.env.NEXT_PUBLIC_ROOQ_ENV;
  return value === "testnet" || value === "local-fork" ? value : "local";
}

export const ENV: EnvironmentId = readEnv();
export const CHAIN_CONFIG: ChainConfig = CHAINS[ENV];
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? CHAIN_CONFIG.rpcUrls[0] ?? "http://127.0.0.1:8545";
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8700/api/v1";
export const MAKER_URL = process.env.NEXT_PUBLIC_MAKER_URL ?? "http://127.0.0.1:8701";
/** Present only in local E2E builds. Enables a connector that signs with anvil's unlocked test accounts. */
export const LOCAL_TEST_WALLET = ENV === "local" && process.env.NEXT_PUBLIC_LOCAL_TEST_WALLET === "1";

export const DEPLOYMENT: Deployment | null = getDeployment(ENV);

export const CHAIN: Chain = defineChain({
  id: CHAIN_CONFIG.chainId,
  name: CHAIN_CONFIG.name,
  nativeCurrency: CHAIN_CONFIG.nativeCurrency,
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: CHAIN_CONFIG.explorerUrl ? { default: { name: "Robinhood Chain explorer", url: CHAIN_CONFIG.explorerUrl } } : undefined,
  testnet: true,
});

export const ENV_LABEL: Record<EnvironmentId, string> = {
  local: "Local chain",
  "local-fork": "Local fork",
  testnet: "Robinhood Chain testnet",
};

export function txUrl(hash: string): string | null {
  return explorerTxUrl(CHAIN_CONFIG, hash);
}

export function addressUrl(address: `0x${string}`): string | null {
  return explorerAddressUrl(CHAIN_CONFIG, address);
}
