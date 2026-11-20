import { CHAIN_CONFIG, ENV, RPC_URL } from "@/lib/env";
import { ACTIVE_TESTNET_PIN, TESTNET_PINS, type DeploymentPin, type RecordVersion } from "./deployment-pin";

/** The private stack. Local defaults match `pnpm --filter @rooq/private-services start:local`. */
export const PRIVATE_READ_URL = process.env.NEXT_PUBLIC_PRIVATE_READ_URL ?? "http://127.0.0.1:8710";
export const PRIVATE_RELAYER_URL = process.env.NEXT_PUBLIC_PRIVATE_RELAYER_URL ?? "http://127.0.0.1:8711";
export const PRIVATE_RPC_URL = process.env.NEXT_PUBLIC_PRIVATE_RPC_URL ?? (ENV === "local" ? "http://127.0.0.1:8548" : RPC_URL);
/** Fixed at build time. A local chain is redeployed on every start, so only the pool binding is checked there. */
export const PRIVATE_DEPLOYMENT_PIN: DeploymentPin | null = ENV === "testnet" ? TESTNET_PINS[ACTIVE_TESTNET_PIN] : null;
/** Unpinned (local) stacks always run the latest circuits. */
export const PRIVATE_RECORD_VERSION: RecordVersion = PRIVATE_DEPLOYMENT_PIN?.recordVersion ?? 2;
export const PRIVATE_CHAIN_ID: number = CHAIN_CONFIG.chainId;
