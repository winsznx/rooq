import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { CHAINS, MAINNET_CHAIN_ID_BLOCKED, getDeployment, type Deployment, type EnvironmentId } from "@rooq/config";

export interface ChainContext {
  readonly env: EnvironmentId;
  readonly chain: Chain;
  readonly deployment: Deployment;
  readonly publicClient: PublicClient<Transport, Chain>;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * Resolves the environment, refuses mainnet and verifies the RPC really serves the configured chain id
 * before any key is used.
 */
export async function loadChain(): Promise<ChainContext> {
  const env = (process.env.ROOQ_ENV ?? "local") as EnvironmentId;
  const cfg = CHAINS[env];
  if (!cfg) throw new Error(`Unknown ROOQ_ENV ${env}`);
  const deployment = getDeployment(env);
  if (!deployment) throw new Error(`No deployment recorded for ${env}. Run the deploy script first.`);
  const rpcUrl = process.env.RPC_URL ?? cfg.rpcUrls[0];
  if (!rpcUrl) throw new Error("No RPC URL configured");
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.name,
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 5_000, retryCount: 2 }) });
  const actual = await publicClient.getChainId();
  if (actual === MAINNET_CHAIN_ID_BLOCKED) throw new Error("Refusing to run against Robinhood Chain mainnet");
  if (actual !== cfg.chainId) throw new Error(`RPC chain id ${actual} does not match ${env} (${cfg.chainId})`);
  if (actual !== deployment.chainId) throw new Error(`Deployment is for chain ${deployment.chainId}, RPC is ${actual}`);
  return { env, chain, deployment, publicClient };
}

export function walletFor(ctx: ChainContext, privateKeyEnv: string): {
  account: PrivateKeyAccount;
  wallet: WalletClient<Transport, Chain, Account>;
} {
  const key = requireEnv(privateKeyEnv) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const rpcUrl = ctx.chain.rpcUrls.default.http[0];
  const wallet = createWalletClient({ account, chain: ctx.chain, transport: http(rpcUrl, { timeout: 10_000 }) });
  return { account, wallet };
}

export function log(service: string, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify(
    { t: new Date().toISOString(), service, event, ...fields },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  );
  console.log(line);
}
