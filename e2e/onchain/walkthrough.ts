/**
 * Mandatory proof walkthrough (05-DELIVERY/ACCEPTANCE_AND_REPORTING.md), executed against real contracts.
 *
 * Wallets: A creator/oracle operator, B maker (quotes come from the running quote service), C trader,
 * D second trader, L liquidator. Every step records its transaction hash, block, gas and status into
 * docs/evidence/walkthrough-<env>.json. Time travel (evm_increaseTime) is used only on local anvil;
 * on testnet those steps wait in real time or are reported as skipped.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { CHAINS, getDeployment, type EnvironmentId } from "@rooq/config";
import {
  clearingHouseAbi,
  marginVaultAbi,
  marketPreflightAbi,
  marketRegistryAbi,
  mockERC20Abi,
  mockPriceFeedAbi,
  oracleAdapterAbi,
  perpLensAbi,
  spotPoolAbi,
  spotRouterAbi,
  type MakerQuote,
} from "@rooq/sdk";

const env = (process.env.ROOQ_ENV ?? "local") as EnvironmentId;
const cfg = CHAINS[env];
const maybeDep = getDeployment(env);
if (!maybeDep) throw new Error(`no deployment for ${env}`);
const dep = maybeDep;
const rpcUrl = process.env.RPC_URL ?? cfg.rpcUrls[0] ?? "http://127.0.0.1:8545";
const makerUrl = process.env.MAKER_URL ?? "http://127.0.0.1:8701";
const chain = defineChain({ id: cfg.chainId, name: cfg.name, nativeCurrency: cfg.nativeCurrency, rpcUrls: { default: { http: [rpcUrl] } } });
const pub = createPublicClient({ chain, transport: http(rpcUrl) });
const isLocal = env !== "testnet";

function key(name: string): PrivateKeyAccount {
  const k = process.env[name];
  if (!k) throw new Error(`missing ${name}`);
  return privateKeyToAccount(k as Hex);
}
const A = key("CREATOR_PRIVATE_KEY");
const C = key("TRADER_PRIVATE_KEY");
const D = key("TRADER2_PRIVATE_KEY");
const L = key("LIQUIDATOR_PRIVATE_KEY");
const wallet = (acct: PrivateKeyAccount) => createWalletClient({ account: acct, chain, transport: http(rpcUrl) });

interface StepRecord {
  readonly gate: string;
  readonly step: string;
  readonly actor?: Address;
  readonly tx?: Hash;
  readonly block?: string;
  readonly gasUsed?: string;
  readonly status?: string;
  readonly events?: readonly string[];
  readonly detail?: Record<string, unknown>;
}
const steps: StepRecord[] = [];
const ABIS: readonly Abi[] = [clearingHouseAbi, marginVaultAbi, marketRegistryAbi, marketPreflightAbi, spotPoolAbi, mockPriceFeedAbi];

function eventNames(receipt: TransactionReceipt): string[] {
  const names: string[] = [];
  for (const log of receipt.logs) {
    for (const abi of ABIS) {
      try {
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
        names.push(decoded.eventName ?? "unknown");
        break;
      } catch {
        continue;
      }
    }
  }
  return names;
}

async function record(gate: string, step: string, actor: PrivateKeyAccount, hash: Hash, detail?: Record<string, unknown>) {
  const r = await pub.waitForTransactionReceipt({ hash });
  steps.push({ gate, step, actor: actor.address, tx: hash, block: r.blockNumber.toString(), gasUsed: r.gasUsed.toString(), status: r.status, events: eventNames(r), detail });
  const label = r.status === "success" ? "ok  " : detail?.expectRevert ? "rej " : "FAIL";
  console.log(`${label} ${gate.padEnd(4)} ${step} ${hash}`);
  if (r.status !== "success" && !detail?.expectRevert) throw new Error(`${step} reverted`);
  return r;
}

function note(gate: string, step: string, detail: Record<string, unknown>) {
  steps.push({ gate, step, detail });
  console.log(`info ${gate.padEnd(4)} ${step} ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}

const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) });

async function warp(seconds: number) {
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
}

const market = dep.markets.find((m) => m.key === "TSLA")!;
const closeOnlyMarket = dep.markets.find((m) => m.key === "AMZN")!;
const memeMarket = dep.markets.find((m) => m.feedMode === "none")!;
const usd = dep.collateral;
const decimals = dep.collateralDecimals;
const unit = 10n ** BigInt(decimals);

async function mark(feedId: Hex): Promise<bigint> {
  const [p, , fresh] = await pub.readContract({ address: dep.oracleAdapter, abi: oracleAdapterAbi, functionName: "getPrice", args: [feedId] });
  if (!fresh) throw new Error("feed is not fresh");
  return p;
}

async function setFeed(feed: Address, price: bigint, step: string, gate = "T12") {
  const answer = price / 10n ** 10n;
  const hash = await wallet(A).writeContract({ address: feed, abi: mockPriceFeedAbi, functionName: "setAnswer", args: [answer] });
  return record(gate, step, A, hash, { answer8: answer.toString() });
}

interface QuoteResponse {
  quote: { [K in keyof MakerQuote]: string | number };
  signature: Hex;
  signer: Address;
  mark: string;
}

async function requestQuote(taker: Address, size: bigint): Promise<{ quote: MakerQuote; signature: Hex; mark: bigint }> {
  const res = await fetch(`${makerUrl}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marketId: market.marketId, taker, size: size.toString() }),
  });
  const body = (await res.json()) as QuoteResponse & { reasonCode?: string; message?: string };
  if (!res.ok) throw new Error(`quote refused: ${body.reasonCode} ${body.message}`);
  const q = body.quote;
  return {
    quote: {
      marketId: q.marketId as Hex,
      maker: q.maker as Address,
      taker: q.taker as Address,
      size: BigInt(q.size),
      price: BigInt(q.price),
      minFill: BigInt(q.minFill),
      nonce: BigInt(q.nonce),
      deadline: BigInt(q.deadline),
      policyVersion: Number(q.policyVersion),
    },
    signature: body.signature,
    mark: BigInt(body.mark),
  };
}

async function tradeVia(trader: PrivateKeyAccount, size: bigint, margin: bigint, gate: string, step: string) {
  const { quote, signature, mark: m } = await requestQuote(trader.address, size);
  const block = await pub.getBlock();
  const { request } = await pub.simulateContract({
    address: dep.clearingHouse,
    abi: clearingHouseAbi,
    functionName: "trade",
    args: [quote, signature, { fillSize: size, marginDeposit: margin, limitPrice: quote.price, maxFeeBps: 10, deadline: block.timestamp + 60n }],
    account: trader,
  });
  const hash = await wallet(trader).writeContract(request);
  return record(gate, step, trader, hash, { size: size.toString(), quotePrice: quote.price.toString(), mark: m.toString(), margin: margin.toString(), nonce: quote.nonce.toString() });
}

async function faucet(who: PrivateKeyAccount, amount: bigint, gate: string) {
  if (dep.collateralMode !== "mock") return;
  await record(gate, "faucet test collateral (mUSD)", who, await wallet(who).writeContract({ address: usd, abi: mockERC20Abi, functionName: "faucet", args: [amount] }));
}

async function deposit(who: PrivateKeyAccount, amount: bigint, gate: string) {
  await record(gate, "approve exact amount to MarginVault", who, await wallet(who).writeContract({ address: usd, abi: mockERC20Abi, functionName: "approve", args: [dep.marginVault, amount] }));
  await record(gate, "deposit collateral to MarginVault", who, await wallet(who).writeContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "deposit", args: [amount, who.address] }));
}

async function conservation(label: string) {
  const [ledger, held] = await Promise.all([
    pub.readContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "totalLedger" }),
    pub.readContract({ address: usd, abi: mockERC20Abi, functionName: "balanceOf", args: [dep.marginVault] }),
  ]);
  note("I-01", `conservation ${label}`, { totalLedger: ledger.toString(), vaultTokenBalance: held.toString(), equal: ledger === held });
  if (ledger !== held) throw new Error("conservation violated");
}

// ------------------------------------------------------------------ run

const chainId = await pub.getChainId();
note("T01", "chain id verified", { chainId, expected: cfg.chainId, env });
if (chainId !== cfg.chainId) throw new Error("wrong chain");
const health = await (await fetch(`${makerUrl}/health`)).json();
note("V1-07", "maker quote service", health as Record<string, unknown>);

// T02: real collateral into our own vault
await faucet(C, 12_000n * unit, "T02");
await deposit(C, 10_000n * unit, "T02");
const freeC = await pub.readContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "balanceOf", args: ["0x0000000000000000000000000000000000000000000000000000000000000000", C.address] });
note("T02", "trader free vault balance", { free: freeC.toString() });

// T03: spot swap and LP on Rooq's own pool
await record("T03", "approve router exact amount", C, await wallet(C).writeContract({ address: usd, abi: mockERC20Abi, functionName: "approve", args: [dep.spotRouter, 1_000n * unit] }));
const path: readonly Address[] = [usd, market.base];
const fees = [Number(market.poolFee)];
const quoted = await pub.readContract({ address: dep.spotRouter, abi: spotRouterAbi, functionName: "quoteExactInput", args: [path, fees, 1_000n * unit] });
const reservesBefore = await pub.readContract({ address: market.pool, abi: spotPoolAbi, functionName: "getReserves" });
const blk = await pub.getBlock();
await record(
  "T03",
  "swap 1,000 collateral for base on Rooq pool",
  C,
  await wallet(C).writeContract({ address: dep.spotRouter, abi: spotRouterAbi, functionName: "swapExactInput", args: [path, fees, 1_000n * unit, (quoted * 995n) / 1000n, C.address, blk.timestamp + 120n] }),
  { quotedOut: quoted.toString(), minOut: ((quoted * 995n) / 1000n).toString(), reservesBefore: reservesBefore.map(String) },
);
const reservesAfter = await pub.readContract({ address: market.pool, abi: spotPoolAbi, functionName: "getReserves" });
note("T03", "pool invariant", { kBefore: (reservesBefore[0] * reservesBefore[1]).toString(), kAfter: (reservesAfter[0] * reservesAfter[1]).toString(), nonDecreasing: reservesAfter[0] * reservesAfter[1] >= reservesBefore[0] * reservesBefore[1] });

// Wallet A adds and removes real LP liquidity
const token0 = await pub.readContract({ address: market.pool, abi: spotPoolAbi, functionName: "token0" });
const baseBal = await pub.readContract({ address: market.base, abi: mockERC20Abi, functionName: "balanceOf", args: [C.address] });
const lpBase = baseBal / 2n;
const lpQuote = (lpBase * (token0 === market.base ? reservesAfter[1] : reservesAfter[0])) / (token0 === market.base ? reservesAfter[0] : reservesAfter[1]) + 1n;
await record("T03", "approve pool (base)", C, await wallet(C).writeContract({ address: market.base, abi: mockERC20Abi, functionName: "approve", args: [market.pool, lpBase] }));
await record("T03", "approve pool (quote)", C, await wallet(C).writeContract({ address: usd, abi: mockERC20Abi, functionName: "approve", args: [market.pool, lpQuote] }));
const b2 = await pub.getBlock();
const lpReceipt = await record(
  "T03",
  "add liquidity, mint LP shares",
  C,
  await wallet(C).writeContract({
    address: market.pool,
    abi: spotPoolAbi,
    functionName: "addLiquidity",
    args: token0 === market.base ? [lpBase, lpQuote, 0n, 0n, C.address, b2.timestamp + 120n] : [lpQuote, lpBase, 0n, 0n, C.address, b2.timestamp + 120n],
  }),
);
const shares = await pub.readContract({ address: market.pool, abi: spotPoolAbi, functionName: "balanceOf", args: [C.address] });
await record("T03", "remove half the LP shares", C, await wallet(C).writeContract({ address: market.pool, abi: spotPoolAbi, functionName: "removeLiquidity", args: [shares / 2n, 0n, 0n, C.address, b2.timestamp + 120n] }), { shares: shares.toString(), lpBlock: lpReceipt.blockNumber.toString() });

// T04: 2x long backed by maker collateral and a signed EIP-712 quote
const lens = (who: Address) => pub.readContract({ address: dep.perpLens, abi: perpLensAbi, functionName: "health", args: [market.marketId, who] });
let px = await mark(market.feedId);
const margin = 2_000n * unit;
// 2x notional less a 1% buffer for the quote spread, so margin covers initial margin at the mark.
const longSize = (margin * 2n * 10n ** 12n * 10n ** 18n * 99n) / (px * 100n);
await tradeVia(C, longSize, margin, "T04", "open 2x long via maker quote");
const pairC = await pub.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "getPair", args: [market.marketId, C.address] });
note("T04", "matched pair state", { takerSize: pairC.size.toString(), maker: pairC.maker, takerMargin: pairC.takerMargin.toString(), makerMargin: pairC.makerMargin.toString(), entry: pairC.entryPrice.toString() });

// T07: funding accrues and settles as a transfer between the pair's two margins
if (isLocal) {
  await warp(3_600);
  await setFeed(market.feed, px, "refresh feed after one hour", "T07");
  const before = await pub.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "getPair", args: [market.marketId, C.address] });
  await record("T07", "settle funding", L, await wallet(L).writeContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "settleFunding", args: [market.marketId, C.address] }));
  const after = await pub.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "getPair", args: [market.marketId, C.address] });
  note("T07", "funding symmetry", {
    takerPaid: (before.takerMargin - after.takerMargin).toString(),
    makerReceived: (after.makerMargin - before.makerMargin).toString(),
    zeroSum: before.takerMargin - after.takerMargin === after.makerMargin - before.makerMargin,
  });
} else {
  note("T07", "funding over real time", { skipped: "testnet uses wall-clock time; run settleFunding after an interval" });
}

// T06: reduce, close, withdraw
px = await mark(market.feedId);
await tradeVia(C, -(longSize / 2n), 0n, "T06", "reduce long by half");
const remaining = (await pub.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "getPair", args: [market.marketId, C.address] })).size;
await tradeVia(C, -remaining, 0n, "T06", "close remaining long");
const freeAfter = await pub.readContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "balanceOf", args: ["0x0000000000000000000000000000000000000000000000000000000000000000", C.address] });
await record("T06", "withdraw all free collateral", C, await wallet(C).writeContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "withdraw", args: [freeAfter, C.address] }), { withdrawn: freeAfter.toString() });

// T05: 2x short from a second trader
await faucet(D, 5_000n * unit, "T05");
await deposit(D, 5_000n * unit, "T05");
px = await mark(market.feedId);
const shortSize = -((2_000n * unit * 2n * 10n ** 12n * 10n ** 18n * 99n) / (px * 100n));
await tradeVia(D, shortSize, 2_000n * unit, "T05", "open 2x short via maker quote");

// T08: healthy account cannot be liquidated, then a controlled oracle move makes it liquidatable
const healthy = await pub
  .simulateContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "liquidate", args: [market.marketId, D.address], account: L })
  .then(() => "unexpectedly allowed")
  .catch((e: Error) => e.message.split("\n").find((l) => l.includes("NotLiquidatable")) ?? e.message.split("\n")[0]);
note("T08", "liquidation of healthy account rejected", { result: healthy });
await setFeed(market.feed, (px * 116n) / 100n, "controlled TEST oracle moves price +16%", "T08");
const h = await lens(D.address);
note("T08", "PerpLens health after move", { takerEquity: h.takerEquity.toString(), maintenance: h.maintenanceMargin.toString(), liquidatable: h.takerLiquidatable });
await record("T08", "third-party liquidation", L, await wallet(L).writeContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "liquidate", args: [market.marketId, D.address] }));
await setFeed(market.feed, px, "restore TEST oracle price", "T08");

// T09: an unqualified market cannot activate perps; rejection is recorded onchain
const [mask, verdict] = await pub.readContract({ address: dep.marketPreflight, abi: marketPreflightAbi, functionName: "previewEligibility", args: [memeMarket.marketId] });
note("T09", "preflight verdict for meme market", { market: memeMarket.symbol, mask: mask.toString(), verdict: ["READY", "NEEDS_FEED", "NEEDS_BACKING", "BLOCKED"][verdict] });
await record(
  "T09",
  "activatePerps on unqualified market (expected revert)",
  A,
  await wallet(A).writeContract({ address: dep.marketPreflight, abi: marketPreflightAbi, functionName: "activatePerps", args: [memeMarket.marketId], gas: 300_000n }),
  { expectRevert: true },
);
const memeStatus = await pub.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "getMarket", args: [memeMarket.marketId] });
note("T09", "meme market after rejected activation", { spotStatus: memeStatus.spotStatus, perpStatus: memeStatus.perpStatus });

await conservation("after trading");

// T12: stale oracle forces close-only (local time travel only)
if (isLocal) {
  await warp(3_601);
  const fresh = await pub.readContract({ address: dep.oracleAdapter, abi: oracleAdapterAbi, functionName: "isFresh", args: [closeOnlyMarket.feedId] });
  note("T12", "feed freshness after 3,601s without updates", { market: closeOnlyMarket.symbol, fresh });
  await record("T12", "permissionless triggerCloseOnly on stale feed", L, await wallet(L).writeContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "triggerCloseOnly", args: [closeOnlyMarket.marketId] }));
  const st = await pub.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "getMarket", args: [closeOnlyMarket.marketId] });
  note("T12", "market status", { market: closeOnlyMarket.symbol, perpStatus: ["NONE", "REGISTERED", "ACTIVE", "CLOSE_ONLY", "PAUSED", "SETTLEMENT_PENDING", "SETTLED"][st.perpStatus] });
  for (const m of dep.markets.filter((x) => x.feedMode === "relay")) {
    const [p] = await pub.readContract({ address: dep.oracleAdapter, abi: oracleAdapterAbi, functionName: "getPrice", args: [m.feedId] });
    await setFeed(m.feed, p, `refresh ${m.symbol} feed`, "T12");
  }
} else {
  note("T12", "stale oracle", { skipped: "on testnet pause the relay for longer than the 3600s heartbeat, then call triggerCloseOnly" });
}

await conservation("end");

const out = join(import.meta.dir, "../../docs/evidence");
mkdirSync(out, { recursive: true });
const file = join(out, `walkthrough-${env}.json`);
writeFileSync(
  file,
  `${JSON.stringify({ env, chainId, rpc: rpcUrl.replace(/\/v2\/.*/, "/v2/<redacted>"), ranAt: new Date().toISOString(), deployment: { clearingHouse: dep.clearingHouse, marginVault: dep.marginVault, marketRegistry: dep.marketRegistry, marketPreflight: dep.marketPreflight }, wallets: { creator: A.address, trader: C.address, trader2: D.address, liquidator: L.address }, steps }, null, 2)}\n`,
);
console.log(`\nwrote ${file} (${steps.length} steps)`);
