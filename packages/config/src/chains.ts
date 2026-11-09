import type { Address } from "./types";

export type EnvironmentId = "local" | "local-fork" | "testnet";

export interface ChainConfig {
  readonly environment: EnvironmentId;
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrls: readonly string[];
  readonly explorerUrl: string | null;
  readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: number };
  /** Robinhood Chain is an Arbitrum Orbit chain; a sequencer receipt is not Ethereum finality. */
  readonly settlementLayer: string | null;
  readonly isTestnet: true;
}

/**
 * Verified 2026-11-07: eth_chainId on https://rpc.testnet.chain.robinhood.com returned 0xb626 (46630),
 * and https://docs.robinhood.com/chain/connecting lists the explorer and RPC below.
 */
export const ROBINHOOD_TESTNET: ChainConfig = {
  environment: "testnet",
  chainId: 46630,
  name: "Robinhood Chain testnet",
  rpcUrls: ["https://rpc.testnet.chain.robinhood.com"],
  explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  settlementLayer: "Ethereum Sepolia",
  isTestnet: true,
};

/** Plain anvil with mock fixtures. Used by Foundry tests, E2E and offline development. */
export const LOCAL_ANVIL: ChainConfig = {
  environment: "local",
  chainId: 31337,
  name: "Local anvil",
  rpcUrls: ["http://127.0.0.1:8545"],
  explorerUrl: null,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  settlementLayer: null,
  isTestnet: true,
};

/**
 * Anvil forked from Robinhood Chain testnet. Keeps chain id 46630 so canonical Stock Token and USDG
 * addresses resolve to their real bytecode. Never confuse its receipts with real testnet receipts:
 * the UI labels this environment "Local fork".
 */
export const LOCAL_FORK: ChainConfig = {
  ...ROBINHOOD_TESTNET,
  environment: "local-fork",
  name: "Local fork of Robinhood Chain testnet",
  rpcUrls: ["http://127.0.0.1:8546"],
  explorerUrl: null,
  settlementLayer: null,
};

export const CHAINS: Record<EnvironmentId, ChainConfig> = {
  local: LOCAL_ANVIL,
  "local-fork": LOCAL_FORK,
  testnet: ROBINHOOD_TESTNET,
};

/** Mainnet is intentionally absent. It requires the audited release gate in docs/known-risks.md. */
export const MAINNET_CHAIN_ID_BLOCKED = 4663;

export function explorerTxUrl(chain: ChainConfig, hash: string): string | null {
  return chain.explorerUrl ? `${chain.explorerUrl}/tx/${hash}` : null;
}

export function explorerAddressUrl(chain: ChainConfig, address: Address): string | null {
  return chain.explorerUrl ? `${chain.explorerUrl}/address/${address}` : null;
}
