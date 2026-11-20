/**
 * Adds a partner's test token as a private perps market through governance:
 *
 *   deploy-feed    MockPriceFeed for the token, operated by the TEST price relay
 *   schedule       governance Safe (2-of-3) calls TimelockController.schedule(OracleAdapter.registerFeed(...))
 *   execute        after the timelock delay, the Safe calls TimelockController.execute for the same operation
 *   create-market  PrivateMarkets.createMarket on the new feed, posting the tier's bond in USDG
 *   status         read-only view of every step
 *
 * Every command prints what it would do and only broadcasts with --send. Keys come from the environment and are never printed:
 *   PARTNER_TX_KEY                 pays for deploy-feed and create-market, and posts the bond
 *   SAFE_SIGNER_1/2/3              Safe owner keys; any two sign the SafeTx (EIP-712), the first of those sends execTransaction
 * Other environment: RPC_URL (default Robinhood Chain testnet), PARTNER_STATE (state file path, default
 * contracts/deployments/partner-<symbol>-<chainId>.json).
 *
 *   bun run scripts/partner-market.ts deploy-feed --symbol QHT --token 0x... --price 1.00 [--send]
 *   bun run scripts/partner-market.ts schedule --symbol QHT [--send]
 *   bun run scripts/partner-market.ts execute --symbol QHT [--send]
 *   bun run scripts/partner-market.ts create-market --symbol QHT [--tier 2] [--max-oi 10000] [--send]
 *   bun run scripts/partner-market.ts status --symbol QHT
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  hashTypedData,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseUnits,
  toHex,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";
const FEED_DECIMALS = 8;
/** Same heartbeat as the genesis perp feeds (DeployPrivatePairs PERP_HEARTBEAT). */
const HEARTBEAT = 3600;
/** Tier C, "Verified volatile asset": 1.25x, the most conservative tier for a token with no external price. */
const DEFAULT_TIER = 2n;
const FIRST_MARKET_ID = 100n;
const WAD = 10n ** 18n;
const ROOT = new URL("../../../", import.meta.url);

const ORACLE_ABI = parseAbi([
  "struct FeedConfig { address aggregator; address asset; uint32 heartbeat; uint8 decimals; bool approved; uint256 minPrice; uint256 maxPrice; }",
  "function registerFeed(bytes32 feedId, address aggregator, address asset, uint32 heartbeat, uint256 minPrice, uint256 maxPrice)",
  "function feedConfig(bytes32 feedId) view returns (FeedConfig)",
  "function getPrice(bytes32 feedId) view returns (uint256 priceWad, uint256 updatedAt, bool fresh)",
  "function admin() view returns (address)",
]);
const FEED_ABI = parseAbi([
  "constructor(uint8 decimals_, string description_, address operator_)",
  "function operator() view returns (address)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const TIMELOCK_ABI = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function getMinDelay() view returns (uint256)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function getOperationState(bytes32 id) view returns (uint8)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);
const SAFE_ABI = parseAbi([
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
]);
const MARKETS_ABI = parseAbi([
  "struct Tier { uint256 imrWad; uint256 mmrWad; uint256 maxOiUsdWad; uint256 takerFeeBps; uint256 penaltyBps; uint256 maxFundingPerHourWad; uint256 maxPairSize; uint256 minBond; uint256 maxCloseSpreadBps; }",
  "function tier(uint256 id) view returns (Tier)",
  "function tierCount() view returns (uint256)",
  "function marketCount() view returns (uint256)",
  "function feedTaken(bytes32 feedId) view returns (bool)",
  "function collateral() view returns (address)",
  "function custody() view returns (address)",
  "function created(uint256 id) view returns (address creator, uint256 bond, bool released)",
  "function createMarket(uint256 tierId, bytes32 feedId, uint256 maxOiUsdWad, uint256 bond) returns (uint256 id)",
]);
const CUSTODY_ABI = parseAbi([
  "struct Market { address asset; bytes32 feedId; uint256 scale; uint256 imrWad; uint256 mmrWad; uint256 penaltyBps; uint256 maxFundingPerHourWad; uint256 takerFeeBps; uint256 maxOiUsdWad; uint256 maxPairSize; uint256 maxCloseSpreadBps; }",
  "function market(uint256 id) view returns (Market)",
  "function closeOnly(uint256 id) view returns (bool)",
  "function marketBond(uint256 id) view returns (uint256)",
]);

/** Safe v1.4.1 SafeTx, hashed as EIP-712 with domain { chainId, verifyingContract }. */
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const OPERATION_STATES = ["Unset", "Waiting", "Ready", "Done"] as const;

interface Deployment {
  readonly chainId: number;
  readonly oracle: Address;
  readonly markets: Address;
  readonly relayOperator: Address;
  readonly governance: { readonly safe: Address; readonly timelock: Address };
}

interface PartnerState {
  symbol: string;
  token: Address;
  feedId: Hex;
  referencePrice: string;
  minPriceWad: string;
  maxPriceWad: string;
  feed: Address | null;
  salt: Hex;
}

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    symbol: { type: "string" },
    token: { type: "string" },
    price: { type: "string" },
    "min-price": { type: "string" },
    "max-price": { type: "string" },
    tier: { type: "string" },
    "max-oi": { type: "string" },
    send: { type: "boolean", default: false },
  },
});
const command = positionals[0];
const send = flags.send === true;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function envKey(name: string): Hex | null {
  const raw = process.env[name];
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) fail(`${name} is not a 32-byte 0x hex key`);
  return raw as Hex;
}

const rpcUrl = process.env.RPC_URL ?? TESTNET_RPC;
const probe = createPublicClient({ transport: http(rpcUrl) });
const chainId = await probe.getChainId();
const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const deploymentPath = new URL(`contracts/deployments/privacy-${chainId}.json`, ROOT);
if (!existsSync(deploymentPath)) fail(`no deployment file for chain ${chainId}`);
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as Deployment;
const { safe, timelock } = deployment.governance;

const symbol = flags.symbol?.toUpperCase() ?? fail("--symbol is required");
if (!/^[A-Z0-9]{1,16}$/.test(symbol)) fail("--symbol must be 1-16 letters or digits");
const statePath = process.env.PARTNER_STATE ?? new URL(`contracts/deployments/partner-${symbol.toLowerCase()}-${chainId}.json`, ROOT).pathname;

function loadState(): PartnerState {
  if (!existsSync(statePath)) fail(`no state at ${statePath}; run deploy-feed first`);
  return JSON.parse(readFileSync(statePath, "utf8")) as PartnerState;
}

function saveState(state: PartnerState): void {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`state written to ${statePath}`);
}

function requireFeed(state: PartnerState): Address {
  return state.feed ?? fail("the feed is not deployed yet; run deploy-feed --send first");
}

function usd(wad: bigint): string {
  return formatUnits(wad, 18);
}

function wallet(account: PrivateKeyAccount) {
  return createWalletClient({ account, chain, transport: http(rpcUrl) });
}

async function confirm(hash: Hex, what: string): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") fail(`${what} reverted (${hash})`);
  console.log(`${what}: ${hash} (block ${receipt.blockNumber})`);
}

function registerCall(state: PartnerState): Hex {
  return encodeFunctionData({
    abi: ORACLE_ABI,
    functionName: "registerFeed",
    args: [state.feedId, requireFeed(state), state.token, HEARTBEAT, BigInt(state.minPriceWad), BigInt(state.maxPriceWad)],
  });
}

async function operationId(state: PartnerState): Promise<Hex> {
  return client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "hashOperation", args: [deployment.oracle, 0n, registerCall(state), zeroHash, state.salt] });
}

function printRegistration(state: PartnerState): void {
  console.log(`  OracleAdapter ${deployment.oracle}.registerFeed(`);
  console.log(`    feedId     ${state.feedId}  (keccak256 "ROOQ:private-v1:${state.symbol}/USD")`);
  console.log(`    aggregator ${state.feed}`);
  console.log(`    asset      ${state.token}`);
  console.log(`    heartbeat  ${HEARTBEAT}s`);
  console.log(`    minPrice   ${usd(BigInt(state.minPriceWad))} USD`);
  console.log(`    maxPrice   ${usd(BigInt(state.maxPriceWad))} USD )`);
}

/**
 * Builds the SafeTx, checks the local EIP-712 hash against Safe.getTransactionHash, signs it with `threshold` owner keys and
 * packs the 65-byte r||s||v signatures in ascending signer order, which is what Safe.checkNSignatures requires.
 */
async function execViaSafe(to: Address, data: Hex, what: string): Promise<void> {
  const [nonce, threshold, owners, version] = await Promise.all([
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: "nonce" }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: "getThreshold" }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: "VERSION" }),
  ]);
  if (version !== "1.4.1") fail(`Safe ${safe} reports version ${version}, expected 1.4.1`);
  const message = { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce };
  const domain = { chainId, verifyingContract: safe } as const;
  const safeTxHash = hashTypedData({ domain, types: SAFE_TX_TYPES, primaryType: "SafeTx", message });
  const onchainHash = await client.readContract({
    address: safe, abi: SAFE_ABI, functionName: "getTransactionHash",
    args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
  });
  if (onchainHash !== safeTxHash) fail(`local safeTxHash ${safeTxHash} differs from the Safe's ${onchainHash}`);

  console.log(`Safe ${safe} (v${version}, ${threshold}-of-${owners.length}) executes ${what}`);
  console.log(`  to ${to}, value 0, operation CALL, nonce ${nonce}`);
  console.log(`  data ${data}`);
  console.log(`  safeTxHash ${safeTxHash} (matches Safe.getTransactionHash)`);

  const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
  const signers = ["SAFE_SIGNER_1", "SAFE_SIGNER_2", "SAFE_SIGNER_3"]
    .map((name) => ({ name, key: envKey(name) }))
    .filter((s): s is { name: string; key: Hex } => s.key !== null)
    .map((s) => ({ name: s.name, account: privateKeyToAccount(s.key) }));
  for (const s of signers) if (!ownerSet.has(s.account.address.toLowerCase())) fail(`${s.name} (${s.account.address}) is not an owner of ${safe}`);
  if (signers.length < Number(threshold)) {
    console.log(`  ${signers.length} of ${threshold} owner keys are set; set SAFE_SIGNER_1/2/3 to sign, or sign the safeTxHash above in the Safe app.`);
    if (send) fail("not enough Safe signer keys to broadcast");
    return;
  }
  const chosen = signers.slice(0, Number(threshold)).sort((a, b) => (BigInt(a.account.address) < BigInt(b.account.address) ? -1 : 1));
  const signatures = concat(await Promise.all(chosen.map((s) => s.account.signTypedData({ domain, types: SAFE_TX_TYPES, primaryType: "SafeTx", message }))));
  console.log(`  signed by ${chosen.map((s) => `${s.name} ${s.account.address}`).join(", ")}; sender ${chosen[0]!.account.address}`);
  if (!send) return console.log("dry run: pass --send to broadcast");
  const hash = await wallet(chosen[0]!.account).writeContract({
    address: safe, abi: SAFE_ABI, functionName: "execTransaction",
    args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures],
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const succeeded = receipt.status === "success" && receipt.logs.some((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0] === keccak256(toHex("ExecutionSuccess(bytes32,uint256)")));
  if (!succeeded) fail(`Safe execution failed (${hash}); the inner call reverted or the signatures were rejected`);
  console.log(`execTransaction: ${hash} (block ${receipt.blockNumber})`);
}

async function deployFeed(): Promise<void> {
  const token = flags.token && isAddress(flags.token) ? getAddress(flags.token) : fail("--token <address> is required");
  const price = flags.price ?? fail("--price <usd> is required, e.g. 1.00");
  if (!/^\d+(\.\d{1,8})?$/.test(price) || parseUnits(price, 18) === 0n) fail("--price must be a positive decimal with up to 8 places");
  if ((await client.getCode({ address: token })) === undefined) fail(`no contract at token ${token}`);
  const priceWad = parseUnits(price, 18);
  const minPriceWad = flags["min-price"] ? parseUnits(flags["min-price"], 18) : priceWad / 100n;
  const maxPriceWad = flags["max-price"] ? parseUnits(flags["max-price"], 18) : priceWad * 100n;
  if (minPriceWad === 0n || maxPriceWad <= minPriceWad || priceWad < minPriceWad || priceWad > maxPriceWad) fail("bounds must satisfy 0 < min <= price <= max and min < max");
  const feedId = keccak256(toHex(`ROOQ:private-v1:${symbol}/USD`));
  const existing = existsSync(statePath) ? loadState() : null;
  if (existing?.feed) fail(`state already has feed ${existing.feed}; delete ${statePath} to start over`);
  const taken = await client.readContract({ address: deployment.oracle, abi: ORACLE_ABI, functionName: "feedConfig", args: [feedId] });
  if (taken.aggregator !== zeroAddress) fail(`feed id ${feedId} is already registered on the oracle`);
  const [tokenSymbol, tokenDecimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const description = `TEST relay ${symbol} / USD (fixed reference)`;
  console.log(`Deploy MockPriceFeed(${FEED_DECIMALS}, "${description}", operator ${deployment.relayOperator})`);
  console.log(`  token ${token} (${tokenSymbol}, ${tokenDecimals} decimals), reference ${price} USD, bounds ${usd(minPriceWad)}..${usd(maxPriceWad)} USD`);
  console.log(`  feedId ${feedId}`);
  const state: PartnerState = {
    symbol, token, feedId, referencePrice: price, minPriceWad: minPriceWad.toString(), maxPriceWad: maxPriceWad.toString(), feed: null,
    salt: keccak256(toHex(`rooq.partner-market.v1:${feedId}`)),
  };
  if (!send) return console.log("dry run: pass --send to broadcast");
  const account = privateKeyToAccount(envKey("PARTNER_TX_KEY") ?? fail("PARTNER_TX_KEY is required to send"));
  const artifact = JSON.parse(readFileSync(new URL("contracts/out/MockPriceFeed.sol/MockPriceFeed.json", ROOT), "utf8")) as { bytecode: { object: Hex } };
  const hash = await wallet(account).deployContract({ abi: FEED_ABI as Abi, bytecode: artifact.bytecode.object, args: [FEED_DECIMALS, description, deployment.relayOperator] });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) fail(`feed deploy failed (${hash})`);
  state.feed = getAddress(receipt.contractAddress);
  console.log(`MockPriceFeed: ${state.feed} (tx ${hash})`);
  saveState(state);
  console.log(`relay config: RELAY_FIXED_FEEDS=${feedId}:${symbol}:${price}`);
}

async function schedule(): Promise<void> {
  const state = loadState();
  const delay = await client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getMinDelay" });
  const id = await operationId(state);
  const opState = await client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getOperationState", args: [id] });
  if (opState !== 0) fail(`operation ${id} is already ${OPERATION_STATES[opState]}`);
  console.log(`TimelockController ${timelock}.schedule(delay ${delay}s, salt ${state.salt}, predecessor 0x0) for:`);
  printRegistration(state);
  console.log(`  operation id ${id}`);
  const data = encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "schedule", args: [deployment.oracle, 0n, registerCall(state), zeroHash, state.salt, delay] });
  await execViaSafe(timelock, data, "TimelockController.schedule");
  if (send) {
    const readyAt = await client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getTimestamp", args: [id] });
    console.log(`ready at ${new Date(Number(readyAt) * 1000).toISOString()} (unix ${readyAt})`);
  }
}

async function execute(): Promise<void> {
  const state = loadState();
  const id = await operationId(state);
  const [opState, readyAt, block] = await Promise.all([
    client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getOperationState", args: [id] }),
    client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getTimestamp", args: [id] }),
    client.getBlock(),
  ]);
  console.log(`TimelockController ${timelock}.execute operation ${id}: ${OPERATION_STATES[opState]}, ready at unix ${readyAt}, chain time ${block.timestamp}`);
  printRegistration(state);
  if (opState !== 2) {
    if (send) fail(`operation is ${OPERATION_STATES[opState]}, not Ready`);
    console.log(`  not Ready yet${opState === 1 ? `; ${readyAt - block.timestamp}s to go` : ""}`);
  }
  const data = encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "execute", args: [deployment.oracle, 0n, registerCall(state), zeroHash, state.salt] });
  await execViaSafe(timelock, data, "TimelockController.execute");
}

async function createMarket(): Promise<void> {
  const state = loadState();
  const tierId = flags.tier ? BigInt(flags.tier) : DEFAULT_TIER;
  const tierCount = await client.readContract({ address: deployment.markets, abi: MARKETS_ABI, functionName: "tierCount" });
  if (tierId >= tierCount) fail(`tier ${tierId} does not exist (${tierCount} tiers)`);
  const [t, collateral, taken, [priceWad, , fresh], approved] = await Promise.all([
    client.readContract({ address: deployment.markets, abi: MARKETS_ABI, functionName: "tier", args: [tierId] }),
    client.readContract({ address: deployment.markets, abi: MARKETS_ABI, functionName: "collateral" }),
    client.readContract({ address: deployment.markets, abi: MARKETS_ABI, functionName: "feedTaken", args: [state.feedId] }),
    client.readContract({ address: deployment.oracle, abi: ORACLE_ABI, functionName: "getPrice", args: [state.feedId] }),
    client.readContract({ address: deployment.oracle, abi: ORACLE_ABI, functionName: "feedConfig", args: [state.feedId] }).then((c) => c.approved),
  ]);
  const maxOi = flags["max-oi"] ? parseUnits(flags["max-oi"], 18) : t.maxOiUsdWad;
  const bond = t.minBond;
  const [collateralSymbol, collateralDecimals] = await Promise.all([
    client.readContract({ address: collateral, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: collateral, abi: erc20Abi, functionName: "decimals" }),
  ]);
  console.log(`PrivateMarkets ${deployment.markets}.createMarket(tier ${tierId}, feed ${state.feedId}, maxOi ${usd(maxOi)} USD, bond ${formatUnits(bond, collateralDecimals)} ${collateralSymbol})`);
  console.log(`  tier ${tierId}: imr ${usd(t.imrWad)}, mmr ${usd(t.mmrWad)}, tier max OI ${usd(t.maxOiUsdWad)} USD, max pair ${usd(t.maxPairSize)} tokens, min bond ${formatUnits(t.minBond, collateralDecimals)}`);
  const problems: string[] = [];
  if (!approved) problems.push("feed is not approved on the oracle yet (run execute)");
  if (!fresh) problems.push("feed price is not fresh; the relay must write it first (RELAY_FIXED_FEEDS)");
  if (taken) problems.push("feed already backs a market");
  if (maxOi === 0n || maxOi > t.maxOiUsdWad) problems.push(`max OI must be in (0, ${usd(t.maxOiUsdWad)}]`);
  if (fresh && t.maxPairSize * priceWad * 10n > maxOi * WAD) {
    problems.push(`pair-size rule fails: max pair ${usd(t.maxPairSize)} x price ${usd(priceWad)} x 10 > max OI ${usd(maxOi)}; pick a lower-price feed, a higher max OI or another tier`);
  } else if (fresh) {
    console.log(`  pair-size rule: ${usd(t.maxPairSize * priceWad / WAD)} USD x 10 <= ${usd(maxOi)} USD ok (price ${usd(priceWad)})`);
  }
  const key = envKey("PARTNER_TX_KEY");
  if (key) {
    const creator = privateKeyToAccount(key).address;
    const [balance, allowance] = await Promise.all([
      client.readContract({ address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [creator] }),
      client.readContract({ address: collateral, abi: erc20Abi, functionName: "allowance", args: [creator, deployment.markets] }),
    ]);
    console.log(`  creator ${creator}: ${formatUnits(balance, collateralDecimals)} ${collateralSymbol}, allowance ${formatUnits(allowance, collateralDecimals)}`);
    if (balance < bond) problems.push(`creator holds less than the ${formatUnits(bond, collateralDecimals)} ${collateralSymbol} bond`);
  }
  for (const p of problems) console.log(`  blocked: ${p}`);
  if (!send) return console.log("dry run: pass --send to broadcast");
  if (problems.length > 0) fail("createMarket would revert");
  const account = privateKeyToAccount(key ?? fail("PARTNER_TX_KEY is required to send"));
  const w = wallet(account);
  const allowance = await client.readContract({ address: collateral, abi: erc20Abi, functionName: "allowance", args: [account.address, deployment.markets] });
  if (allowance < bond) await confirm(await w.writeContract({ address: collateral, abi: erc20Abi, functionName: "approve", args: [deployment.markets, bond] }), `approve ${collateralSymbol}`);
  const { result: id, request } = await client.simulateContract({ account, address: deployment.markets, abi: MARKETS_ABI, functionName: "createMarket", args: [tierId, state.feedId, maxOi, bond] });
  await confirm(await w.writeContract(request), `createMarket -> market ${id}`);
}

async function findMarket(feedId: Hex): Promise<bigint | null> {
  const count = await client.readContract({ address: deployment.markets, abi: MARKETS_ABI, functionName: "marketCount" });
  const custody = await client.readContract({ address: deployment.markets, abi: MARKETS_ABI, functionName: "custody" });
  for (let id = FIRST_MARKET_ID; id < FIRST_MARKET_ID + count; id++) {
    const m = await client.readContract({ address: custody, abi: CUSTODY_ABI, functionName: "market", args: [id] });
    if (m.feedId === feedId) return id;
  }
  return null;
}

async function status(): Promise<void> {
  const state = loadState();
  console.log(`${state.symbol} on chain ${chainId}: token ${state.token}, feedId ${state.feedId}, reference ${state.referencePrice} USD`);
  if (!state.feed) return console.log("  feed: not deployed");
  const feed = state.feed;
  const [operator, [, answer, , updatedAt], block] = await Promise.all([
    client.readContract({ address: feed, abi: FEED_ABI, functionName: "operator" }),
    client.readContract({ address: feed, abi: FEED_ABI, functionName: "latestRoundData" }),
    client.getBlock(),
  ]);
  console.log(`  feed ${feed}: operator ${operator}${operator === deployment.relayOperator ? " (price relay)" : " (NOT the price relay)"}, answer ${formatUnits(answer, FEED_DECIMALS)}, ${updatedAt === 0n ? "never written" : `age ${block.timestamp - updatedAt}s`}`);
  const id = await operationId(state);
  const [opState, readyAt] = await Promise.all([
    client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getOperationState", args: [id] }),
    client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getTimestamp", args: [id] }),
  ]);
  console.log(`  timelock operation ${id}: ${OPERATION_STATES[opState]}${opState === 1 ? `, ready in ${readyAt - block.timestamp}s` : ""}`);
  const [cfg, [priceWad, , fresh]] = await Promise.all([
    client.readContract({ address: deployment.oracle, abi: ORACLE_ABI, functionName: "feedConfig", args: [state.feedId] }),
    client.readContract({ address: deployment.oracle, abi: ORACLE_ABI, functionName: "getPrice", args: [state.feedId] }),
  ]);
  console.log(`  oracle: ${cfg.aggregator === zeroAddress ? "not registered" : `registered, approved ${cfg.approved}, heartbeat ${cfg.heartbeat}s, price ${usd(priceWad)}, fresh ${fresh}`}`);
  const market = await findMarket(state.feedId);
  if (market === null) return console.log("  market: not created");
  const custody = await client.readContract({ address: deployment.markets, abi: MARKETS_ABI, functionName: "custody" });
  const [m, closeOnly, bond, [creator]] = await Promise.all([
    client.readContract({ address: custody, abi: CUSTODY_ABI, functionName: "market", args: [market] }),
    client.readContract({ address: custody, abi: CUSTODY_ABI, functionName: "closeOnly", args: [market] }),
    client.readContract({ address: custody, abi: CUSTODY_ABI, functionName: "marketBond", args: [market] }),
    client.readContract({ address: deployment.markets, abi: MARKETS_ABI, functionName: "created", args: [market] }),
  ]);
  const view = {
    id: market.toString(), symbol: state.symbol, feedId: m.feedId, collateral: m.asset, creator, bond: bond.toString(), closeOnly,
    imrWad: m.imrWad.toString(), mmrWad: m.mmrWad.toString(), maxOiUsdWad: m.maxOiUsdWad.toString(), maxPairSize: m.maxPairSize.toString(),
    takerFeeBps: m.takerFeeBps.toString(), penaltyBps: m.penaltyBps.toString(), maxCloseSpreadBps: m.maxCloseSpreadBps.toString(),
    price: { priceWad: priceWad.toString(), fresh },
  };
  console.log(`  market ${market}:`);
  console.log(JSON.stringify(view, null, 2));
}

const commands: Record<string, () => Promise<void>> = { "deploy-feed": deployFeed, schedule, execute, "create-market": createMarket, status };
const run = command ? commands[command] : undefined;
if (!run) fail(`usage: partner-market.ts <${Object.keys(commands).join("|")}> --symbol <SYM> [--send]`);
console.log(`chain ${chainId} via ${rpcUrl.replace(/\/\/[^/]*@/, "//")}${send ? "" : " (dry run)"}`);
await run();
