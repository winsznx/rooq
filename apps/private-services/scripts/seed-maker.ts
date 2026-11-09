/**
 * Funds the maker's shielded wallet on testnet from the deployer's USDG and prints MAKER_TERMS for the current prices.
 * Keys come from the environment only.
 *
 *   DEPLOYER_KEY=... MAKER_SEED=... bun run scripts/seed-maker.ts
 */
import { readFileSync } from "node:fs";
import { depositOpening, deriveKeys, initCrypto, noteInner, toHex32 } from "@rooq/private-sdk";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = "https://rpc.testnet.chain.robinhood.com";
const NOTE_USDG = 100_000_000n;
const SPREAD_BPS = 20;
const CLOSE_SPREAD_BPS = 30;
const LOCKS_PER_MARKET = 1;
const MAX_NOTIONAL_USD = 160n;

interface Deployment {
  readonly pool: Address;
  readonly asset: Address;
  readonly perpFeeds: readonly Address[];
  readonly perpMarketIds: readonly (string | number)[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const deployment = JSON.parse(readFileSync(new URL("../../../contracts/deployments/privacy-46630.json", import.meta.url), "utf8")) as Deployment;
const chain = defineChain({ id: 46630, name: "Robinhood Chain testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const client = createPublicClient({ chain, transport: http(RPC_URL) });
const account = privateKeyToAccount(required("DEPLOYER_KEY") as Hex);
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
const poolAbi = parseAbi(["function shield(address asset, uint256 amount, bytes32 noteInner)"]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

async function confirmed(hash: Hex, label: string): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  console.log(`${label} ${hash}`);
}

await initCrypto();
const seed = BigInt(required("MAKER_SEED"));
const owner = deriveKeys(seed).owner;
const count = deployment.perpFeeds.length;

await confirmed(await wallet.writeContract({ address: deployment.asset, abi: erc20Abi, functionName: "approve", args: [deployment.pool, NOTE_USDG * BigInt(count)] }), "approve");
for (let k = 0; k < count; k++) {
  const { rho, blind } = depositOpening(seed, k);
  await confirmed(await wallet.writeContract({ address: deployment.pool, abi: poolAbi, functionName: "shield", args: [deployment.asset, NOTE_USDG, toHex32(noteInner(owner, rho, blind)) as Hex] }), `shield ${k}`);
}

const terms: string[] = [];
for (const [i, feed] of deployment.perpFeeds.entries()) {
  const [, answer] = await client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" });
  const maxSize = (MAX_NOTIONAL_USD * 10n ** 26n) / answer;
  terms.push(`${deployment.perpMarketIds[i]}:${SPREAD_BPS}:${maxSize}:${CLOSE_SPREAD_BPS}:${NOTE_USDG}:${LOCKS_PER_MARKET}`);
}
console.log(`MAKER_TERMS=${terms.join(",")}`);
