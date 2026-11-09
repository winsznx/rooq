import type { Address, Hex } from "./types";
import type { EnvironmentId } from "./chains";
import local from "./deployments/local.json";

export interface DeployedMarket {
  readonly key: string;
  readonly symbol: string;
  readonly name: string;
  /** "mock" = test fixture deployed by Rooq; "existing" = canonical third-party token. */
  readonly mode: "mock" | "existing";
  readonly feedMode: "relay" | "none";
  readonly tier: string;
  readonly poolFee: string;
  readonly heartbeat: string;
  readonly marketId: Hex;
  readonly base: Address;
  readonly pool: Address;
  readonly feed: Address;
  readonly feedId: Hex;
}

export interface Deployment {
  readonly env: EnvironmentId;
  readonly chainId: number;
  readonly deployBlock: number;
  readonly deployer: Address;
  readonly guardian: Address;
  readonly feeRecipient: Address;
  readonly oracleOperator: Address;
  readonly collateral: Address;
  readonly collateralSymbol: string;
  readonly collateralName: string;
  readonly collateralDecimals: number;
  readonly collateralMode: "mock" | "existing";
  readonly oracleAdapter: Address;
  readonly marginVault: Address;
  readonly spotFactory: Address;
  readonly spotRouter: Address;
  readonly marketRegistry: Address;
  readonly marketBackstop: Address;
  readonly clearingHouse: Address;
  readonly marketPreflight: Address;
  readonly perpLens: Address;
  readonly markets: readonly DeployedMarket[];
}

/**
 * Deployments known to this build. Testnet is absent until a real broadcast exists; the app then shows
 * "Not deployed on this network" rather than inventing addresses.
 */
export const DEPLOYMENTS: Partial<Record<EnvironmentId, Deployment>> = {
  local: local as Deployment,
};

export function getDeployment(env: EnvironmentId): Deployment | null {
  return DEPLOYMENTS[env] ?? null;
}
