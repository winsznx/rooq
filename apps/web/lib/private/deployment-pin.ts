import type { Address } from "viem";

/** 1 is the plain personal_sign text; 2 is an origin-bound SIWE message with a normalized signature (audit 26, 27). */
export type AccountDerivation = 1 | 2;

/** The record layout a deployment's circuits commit to. 1 is before M36; 2 adds pair timestamps, LP price bands and fee outputs. */
export type RecordVersion = 1 | 2;

/**
 * The private deployment this build talks to. The wallet approves and shields to `pool`, so it must never come from a
 * service: a read API that names another contract would receive the deposit (internal audit finding 2).
 */
export interface DeploymentPin {
  readonly chainId: number;
  readonly pool: Address;
  readonly spot: Address;
  readonly asset: Address;
  readonly deploymentId: bigint;
  /** Which account-derivation message this deployment's accounts were opened with (lib/private/account.ts). */
  readonly accountDerivation: AccountDerivation;
  /** Selects the record reader (`@rooq/private-sdk/legacy/v1` for 1). Never inferred by trial decoding. */
  readonly recordVersion: RecordVersion;
}

/** contracts/deployments/privacy-46630-v1.json, the first deployment (Nov 9). */
export const TESTNET_PRIVATE_DEPLOYMENT: DeploymentPin = {
  chainId: 46630,
  pool: "0x6b3dEA9d7C3FaCbFd8Eb78c101f0C0fF45648DF5",
  spot: "0x0F792918dC1949de932AC11446fba82beBa32404",
  asset: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
  deploymentId: 68150433591535802731563366965268384349227101366554101n,
  accountDerivation: 1,
  recordVersion: 1,
};

/** contracts/deployments/privacy-46630.json, the M36 redeploy (Nov 18). */
export const TESTNET_PRIVATE_DEPLOYMENT_M36: DeploymentPin = {
  chainId: 46630,
  pool: "0x4285fb6228ddE782782086f241f8Aa89fDDFb364",
  spot: "0x46Ab17E4ce4065995a726441Ff9385EeE8606309",
  asset: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
  deploymentId: 68150201130028574615962385428955034675092974102098788n,
  accountDerivation: 2,
  recordVersion: 2,
};

export const TESTNET_PINS = { current: TESTNET_PRIVATE_DEPLOYMENT, m36: TESTNET_PRIVATE_DEPLOYMENT_M36 } as const;

/** The one line the M36 deploy changes: "current" to "m36". */
export const ACTIVE_TESTNET_PIN: keyof typeof TESTNET_PINS = "m36";

/** True until a pin names a real deployment. */
export const isPlaceholderPin = (pin: DeploymentPin): boolean => BigInt(pin.pool) === 0n || pin.deploymentId === 0n;

export interface AnnouncedDeployment {
  readonly pool: Address;
  readonly spot: Address | null;
  readonly asset: Address;
  readonly deploymentId: string;
}

const ADDRESS_MASK = (1n << 160n) - 1n;

/** ShieldedPool's constructor sets deploymentId = (chainid << 160) | address(this). */
export const deploymentIdOf = (chainId: number, pool: Address): bigint => (BigInt(chainId) << 160n) | BigInt(pool);

const same = (a: string | null, b: string): boolean => a !== null && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() === b.toLowerCase();

/**
 * Which field of the read API's deployment disagrees with the pin, or null when it matches. Without a pin (a local
 * chain, redeployed on every start) it still requires the id to belong to the announced pool.
 */
export function deploymentMismatch(announced: AnnouncedDeployment, pin: DeploymentPin | null, chainId: number): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(announced.pool)) return "pool";
  if (!/^\d{1,80}$/.test(announced.deploymentId)) return "deploymentId";
  const id = BigInt(announced.deploymentId);
  if ((id & ADDRESS_MASK) !== BigInt(announced.pool)) return "deploymentId";
  if (!pin) return null;
  if (pin.chainId !== chainId || id !== deploymentIdOf(chainId, announced.pool)) return "chain";
  if (!same(announced.pool, pin.pool)) return "pool";
  if (id !== pin.deploymentId) return "deploymentId";
  if (!same(announced.spot, pin.spot)) return "spot";
  if (!same(announced.asset, pin.asset)) return "asset";
  return null;
}

/** The sync error a mismatching deployment raises. Every private action, shielding included, waits on a clean sync. */
export const DEPLOYMENT_MISMATCH = "DEPLOYMENT_MISMATCH";
