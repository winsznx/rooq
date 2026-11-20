/**
 * Seeds a deployment's private spot pools with first liquidity at the oracle price, through the deployment's own relayer and
 * coordinator. The deployer shields each side from its public balances to LP_SEED, then LP_SEED places both LP locks of each
 * pool in one lockPair relay call and the coordinator runs the add. Keys and seeds come from the environment only and are
 * never printed.
 *
 *   DEPLOYER_KEY=... LP_SEED=... READ_URL=... RELAYER_URL=... RPC_URL=... bun run scripts/seed-pools.ts
 *
 * Optional: DEPLOYMENT_FILE (default contracts/deployments/privacy-46630.json, relative to the repo root), USDG_PER_POOL
 * (collateral base units per side, default 90000000 = 90 USDG), POOLS (comma list of pool ids, default every pool in the
 * record's poolMap), START_K (first deposit index to try, default 0).
 *
 * Rerunnable: unspent notes LP_SEED already holds cover what they can before anything new is shielded, deposit indexes
 * already used on chain are skipped, and pools that are already seeded are left alone.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  addressOf, bandForDeposit, depositDerivation, depositOpening, deriveKeys, EMPTY_POOL, initCrypto, lockAddressKeys, lockWitness, lpAddOutcome, lpBandTerms, LP_CT_LEN, MerkleTree, noteInner,
  openLp, RECORD_LP, recNullifier, toHex32, type LockTerms, type ShieldedDeposit, type WalletKeys,
} from "@rooq/private-sdk";
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex } from "../src/lib/chain";
import { REPO_ROOT } from "../src/lib/config";
import { Provers } from "../src/lib/provers";
import { ShieldedWallet, type SpendableNote, type WalletRecord } from "../src/lib/wallet";

const DEFAULT_USDG_PER_POOL = 90_000_000n;
const LP_LOCK_TTL_S = 86_400n;
const BAND_SLIPPAGE_BPS = 100;
const DEPOSIT_TIMEOUT_MS = 10 * 60_000;
const JOB_TIMEOUT_MS = 5 * 60_000;
const ADD_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 1_000;
const PROVER_THREADS = 4;

interface Deployment {
  readonly chainId: number;
  readonly deploymentId: string;
  readonly pool: Address;
  readonly spot: Address;
  readonly asset: Address;
  readonly heartbeat?: number;
  readonly poolMap?: string;
  readonly perpTokens?: readonly Address[];
  readonly perpFeeds?: readonly Address[];
}

interface PoolRow { readonly id: string; readonly token0: Hex; readonly token1: Hex; readonly seeded: boolean }
interface SyncView { readonly syncedBlock: string | null; readonly processed: number; readonly queueLength: number }
interface RecordRow { readonly leafIndex: number; readonly kind: number; readonly commitment: Hex; readonly ciphertext: Hex[] }
interface DepositRow { readonly leafIndex: number; readonly asset: Hex; readonly amount: string; readonly inner: Hex }
interface Job { readonly status: string; readonly reasonCode: string | null; readonly block: string | null }

interface PoolPlan {
  readonly id: bigint;
  readonly tokens: readonly [Address, Address];
  readonly symbols: readonly [string, string];
  readonly decimals: readonly [number, number];
  readonly amounts: readonly [bigint, bigint];
}

class SeedError extends Error {}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new SeedError(`${name} is required`);
  return value;
}

const baseUrl = (name: string): string => required(name).replace(/\/+$/, "");

const READ_URL = baseUrl("READ_URL");
const RELAYER_URL = baseUrl("RELAYER_URL");
const RPC_URL = required("RPC_URL");
const USDG_PER_POOL = BigInt(process.env.USDG_PER_POOL ?? DEFAULT_USDG_PER_POOL);
const START_K = Number(process.env.START_K ?? 0);
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE ?? "contracts/deployments/privacy-46630.json";
if (USDG_PER_POOL <= 0n) throw new SeedError("USDG_PER_POOL must be positive");
if (!Number.isSafeInteger(START_K) || START_K < 0) throw new SeedError("START_K must be a non-negative integer");

const deployment = JSON.parse(readFileSync(isAbsolute(DEPLOYMENT_FILE) ? DEPLOYMENT_FILE : `${REPO_ROOT}${DEPLOYMENT_FILE}`, "utf8")) as Deployment;
const deploymentId = BigInt(deployment.deploymentId);
const client = createPublicClient({ transport: http(RPC_URL) });
const deployer = privateKeyToAccount(required("DEPLOYER_KEY") as Hex);
const lpSeed = BigInt(required("LP_SEED"));

const poolAbi = parseAbi([
  "function shield(address asset, uint256 amount, bytes32 inner) returns (uint256)",
  "function usedInner(bytes32) view returns (bool)",
  "function coordinatorX() view returns (uint256)", "function coordinatorY() view returns (uint256)",
  "function riskAX() view returns (uint256)", "function riskAY() view returns (uint256)",
  "function riskBX() view returns (uint256)", "function riskBY() view returns (uint256)",
]);
const feedAbi = parseAbi(["function decimals() view returns (uint8)", "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const jsonBigint = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
const addressOfWord = (word: Hex): Address => getAddress(`0x${BigInt(word).toString(16).padStart(40, "0")}`);

function units(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const frac = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${amount / scale}.${frac}` : `${amount / scale}`;
}

async function waitFor<T>(what: string, fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new SeedError(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new SeedError(`${init?.method ?? "GET"} ${url}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function pageAll<T>(url: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ;) {
    const page = await getJson<{ items: T[]; nextFrom: number | null }>(`${url}?from=${from}&limit=256`);
    out.push(...page.items);
    if (page.nextFrom === null) return out;
    from = page.nextFrom;
  }
}

/** Waits until the read API has indexed `minBlock` and the queue processor has put every entry queued by then into the tree. */
async function waitProcessed(minBlock: bigint, what: string): Promise<void> {
  const indexed = await waitFor(`the read API to index block ${minBlock} (${what})`, async () => {
    const s = await getJson<SyncView>(`${READ_URL}/v1/sync`);
    return s.syncedBlock !== null && BigInt(s.syncedBlock) >= minBlock ? s : null;
  }, DEPOSIT_TIMEOUT_MS);
  let last = indexed;
  try {
    await waitFor(`the queue to process ${what}`, async () => {
      last = await getJson<SyncView>(`${READ_URL}/v1/sync`);
      return last.processed >= indexed.queueLength ? last : null;
    }, DEPOSIT_TIMEOUT_MS);
  } catch (error) {
    throw new SeedError(`queue not processing: ${last.processed} of ${indexed.queueLength} entries in the tree. ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** LP_SEED's shielded view: its notes, its locks' one-time addresses and its LP claims, from the read API alone. */
class LpWallet {
  readonly wallet = new ShieldedWallet(lpSeed, deploymentId);
  readonly main: WalletKeys = deriveKeys(lpSeed);
  tree = new MerkleTree();
  records: WalletRecord[] = [];
  private deposits: ShieldedDeposit[] = [];
  private processed = 0;
  private usedPayouts = 0;

  async refresh(): Promise<void> {
    const rows = await pageAll<RecordRow>(`${READ_URL}/v1/records`);
    this.records = rows.map((r) => ({ leafIndex: r.leafIndex, kind: r.kind, commitment: BigInt(r.commitment), ciphertext: r.ciphertext.map(BigInt) }));
    const deps = await pageAll<DepositRow>(`${READ_URL}/v1/deposits`);
    this.deposits = deps.map((d) => ({ leafIndex: d.leafIndex, asset: BigInt(d.asset), amount: BigInt(d.amount), inner: BigInt(d.inner) }));
    const tree = new MerkleTree();
    for (let from = 0; ;) {
      const page = await getJson<{ leaves: Hex[]; processed: number }>(`${READ_URL}/v1/tree/leaves?from=${from}&limit=512`);
      for (const leaf of page.leaves) tree.insert(BigInt(leaf));
      from += page.leaves.length;
      if (page.leaves.length === 0 || from >= page.processed) {
        this.processed = page.processed;
        break;
      }
    }
    this.tree = tree;
  }

  private async spentFlags(nullifiers: readonly bigint[]): Promise<boolean[]> {
    const out: boolean[] = [];
    for (let i = 0; i < nullifiers.length; i += 200) {
      const chunk = nullifiers.slice(i, i + 200).map(toHex32);
      const res = await getJson<{ spent: boolean[] }>(`${READ_URL}/v1/nullifiers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nullifiers: chunk }) });
      out.push(...res.spent);
    }
    return out;
  }

  async notes(): Promise<SpendableNote[]> {
    await this.refresh();
    const all = this.wallet.notes(this.records, this.deposits, this.processed, () => false);
    const spent = await this.spentFlags(all.map((n) => n.nullifier));
    return all.filter((_, i) => !spent[i]);
  }

  nextPayout(): WalletKeys {
    const index = Math.max(this.usedPayouts, this.wallet.usedAddresses(this.records).next);
    this.usedPayouts = index + 1;
    return lockAddressKeys(lpSeed, index);
  }

  async lpShares(payout: WalletKeys): Promise<bigint | null> {
    await this.refresh();
    for (const r of this.records) {
      if (r.kind !== RECORD_LP) continue;
      const claim = openLp(r.ciphertext.slice(0, LP_CT_LEN), payout.encSk, deploymentId, r.commitment);
      if (claim && !(await this.spentFlags([recNullifier(r.commitment, claim.recNonce)]))[0]) return claim.shares;
    }
    return null;
  }
}

async function submitRelay(action: string, body: string): Promise<string> {
  const res = await fetch(`${RELAYER_URL}/v1/relay/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const json = (await res.json().catch(() => ({}))) as { id?: string; reasonCode?: string; message?: string };
  if (!res.ok || !json.id) throw new SeedError(`relayer refused ${action}: ${res.status} ${json.reasonCode ?? ""} ${json.message ?? ""}`.trim());
  return json.id;
}

async function waitJob(id: string): Promise<bigint> {
  const job = await waitFor(`relay job ${id} to confirm`, async () => {
    const j = await getJson<Job>(`${RELAYER_URL}/v1/jobs/${id}`);
    if (j.status === "reverted") throw new SeedError(`relay job ${id} reverted: ${j.reasonCode ?? "no reason"}`);
    return j.status === "confirmed" ? j : null;
  }, JOB_TIMEOUT_MS);
  return BigInt(job.block ?? 0);
}

async function tokenInfo(token: Address): Promise<{ symbol: string; decimals: number }> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { symbol, decimals };
}

/** USD per whole token as a fraction, from the token's perps feed; the collateral counts as one dollar. */
async function usdPrice(token: Address, now: bigint): Promise<{ num: bigint; den: bigint }> {
  if (getAddress(token) === getAddress(deployment.asset)) return { num: 1n, den: 1n };
  const index = (deployment.perpTokens ?? []).findIndex((t) => getAddress(t) === getAddress(token));
  const feed = deployment.perpFeeds?.[index];
  if (index < 0 || !feed) throw new SeedError(`no perps feed for token ${token} in the deployment record`);
  const [decimals, [, answer, , updatedAt]] = await Promise.all([
    client.readContract({ address: feed, abi: feedAbi, functionName: "decimals" }),
    client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" }),
  ]);
  if (answer <= 0n) throw new SeedError(`feed ${feed} for ${token} has no price`);
  const heartbeat = BigInt(deployment.heartbeat ?? 3_600);
  if (now - updatedAt > heartbeat) throw new SeedError(`feed ${feed} for ${token} is stale: last update ${now - updatedAt} s ago, heartbeat ${heartbeat} s`);
  return { num: answer, den: 10n ** BigInt(decimals) };
}

async function plan(pool: PoolRow, usdgDecimals: number, now: bigint): Promise<PoolPlan> {
  const tokens = [addressOfWord(pool.token0), addressOfWord(pool.token1)] as const;
  const [info0, info1] = await Promise.all(tokens.map(tokenInfo));
  const [price0, price1] = await Promise.all(tokens.map((t) => usdPrice(t, now)));
  // Each side is worth USDG_PER_POOL at the oracle price, so the pool opens at the market price.
  const sideAmount = (info: { decimals: number }, price: { num: bigint; den: bigint }): bigint =>
    (USDG_PER_POOL * 10n ** BigInt(info.decimals) * price.den) / (price.num * 10n ** BigInt(usdgDecimals));
  const amounts = [sideAmount(info0!, price0!), sideAmount(info1!, price1!)] as const;
  if (amounts[0] === 0n || amounts[1] === 0n) throw new SeedError(`pool ${pool.id}: USDG_PER_POOL is too small to buy one base unit of each side`);
  if (lpAddOutcome(amounts[0], amounts[1], EMPTY_POOL).shares === 0n) throw new SeedError(`pool ${pool.id}: the deposit is below the pool's minimum liquidity`);
  return { id: BigInt(pool.id), tokens, symbols: [info0!.symbol, info1!.symbol], decimals: [info0!.decimals, info1!.decimals], amounts };
}

/** The coordinator's quote for a small swap of token0, as the price the pool now trades at next to the deposit's own price. */
async function quoteCheck(p: PoolPlan): Promise<string> {
  const amountIn = p.amounts[0] / 1_000n;
  if (amountIn === 0n) return "quote skipped (deposit too small)";
  try {
    const q = await getJson<{ amountOut: string }>(`${READ_URL}/v1/spot/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: p.id.toString(), assetIn: p.tokens[0], amountIn: amountIn.toString() }) });
    const scale = 10n ** BigInt(p.decimals[0]);
    return `quote ${units(amountIn, p.decimals[0])} ${p.symbols[0]} -> ${units(BigInt(q.amountOut), p.decimals[1])} ${p.symbols[1]} (deposit ratio ${units((p.amounts[1] * scale) / p.amounts[0], p.decimals[1])} ${p.symbols[1]} per ${p.symbols[0]})`;
  } catch (error) {
    return `quote unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

interface Need { readonly pool: bigint; readonly side: 0 | 1; readonly asset: Address; readonly amount: bigint }

/** Gives each need the smallest unclaimed note of its asset that covers it. */
function allocate(needs: readonly Need[], notes: readonly SpendableNote[]): { matched: Map<Need, SpendableNote>; missing: Need[] } {
  const free = [...notes].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const matched = new Map<Need, SpendableNote>();
  const missing: Need[] = [];
  for (const need of [...needs].sort((a, b) => (a.amount > b.amount ? -1 : 1))) {
    const i = free.findIndex((n) => n.asset === BigInt(need.asset) && n.value >= need.amount);
    if (i < 0) missing.push(need);
    else matched.set(need, free.splice(i, 1)[0]!);
  }
  return { matched, missing };
}

async function shieldMissing(missing: readonly Need[], symbolOf: (a: Address) => string, show: (a: Address, amount: bigint) => string): Promise<number> {
  const chain = { id: deployment.chainId, name: `chain ${deployment.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
  const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC_URL) });
  const totals = new Map<Address, bigint>();
  for (const n of missing) totals.set(n.asset, (totals.get(n.asset) ?? 0n) + n.amount);
  for (const [asset, total] of totals) {
    const balance = await client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [deployer.address] });
    if (balance < total) throw new SeedError(`insufficient public balance: deployer ${deployer.address} holds ${show(asset, balance)}, needs ${show(asset, total)}`);
  }
  if ((await client.getBalance({ address: deployer.address })) === 0n) throw new SeedError(`deployer ${deployer.address} has no gas`);

  const send = async (label: string, request: Parameters<typeof wallet.writeContract>[0]): Promise<bigint> => {
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new SeedError(`${label} reverted in ${hash}`);
    console.log(`  ${label} ${hash}`);
    return receipt.blockNumber;
  };
  for (const [asset, total] of totals) {
    const allowance = await client.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [deployer.address, deployment.pool] });
    if (allowance < total) await send(`approve ${symbolOf(asset)}`, { address: asset, abi: erc20Abi, functionName: "approve", args: [deployment.pool, total], account: deployer, chain });
  }

  const owner = deriveKeys(lpSeed).owner;
  // The derivation the services' wallet scans with, bound to this deployment.
  const derivation = depositDerivation(2, deploymentId);
  const innerAt = (k: number): Hex => {
    const { rho, blind } = depositOpening(lpSeed, k, derivation);
    return toHex32(noteInner(owner, rho, blind)) as Hex;
  };
  const isUsed = (inner: Hex): Promise<boolean> => client.readContract({ address: deployment.pool, abi: poolAbi, functionName: "usedInner", args: [inner] });
  let k = START_K;
  let lastBlock = 0n;
  for (const need of missing) {
    while (await isUsed(innerAt(k))) k++;
    lastBlock = await send(`shield k=${k} ${show(need.asset, need.amount)} for pool ${need.pool}`, {
      address: deployment.pool, abi: poolAbi, functionName: "shield", args: [need.asset, need.amount, innerAt(k)], account: deployer, chain,
    });
    k++;
  }
  if (lastBlock > 0n) await waitProcessed(lastBlock, `${missing.length} deposits`);
  while (await isUsed(innerAt(k))) k++;
  return k;
}

async function main(): Promise<void> {
  await initCrypto();
  const chainId = await client.getChainId();
  if (chainId !== deployment.chainId) throw new SeedError(`RPC_URL is chain ${chainId}, the deployment record is for ${deployment.chainId}`);

  const listed = await getJson<{ spot: string | null; pools: PoolRow[] }>(`${READ_URL}/v1/spot/pools`);
  if (!listed.spot || getAddress(listed.spot) !== getAddress(deployment.spot)) throw new SeedError(`READ_URL serves spot ${listed.spot}, the deployment record has ${deployment.spot}`);
  const fromMap = deployment.poolMap ? deployment.poolMap.split(",").map((e) => e.split(":")[1]!.trim()) : listed.pools.map((p) => p.id);
  const ids = process.env.POOLS ? process.env.POOLS.split(",").map((s) => s.trim()).filter(Boolean) : fromMap;
  const selected: PoolRow[] = [];
  for (const id of ids) {
    const row = listed.pools.find((p) => p.id === id);
    if (!row) throw new SeedError(`pool ${id} is not on ${READ_URL}`);
    if (row.seeded) console.log(`pool ${id}: already seeded, skipped`);
    else selected.push(row);
  }
  if (selected.length === 0) {
    console.log("nothing to seed");
    return;
  }

  const usdg = await tokenInfo(deployment.asset);
  const now = (await client.getBlock()).timestamp;
  const plans: PoolPlan[] = [];
  for (const row of selected) plans.push(await plan(row, usdg.decimals, now));
  const tokens = new Map<Address, { symbol: string; decimals: number }>();
  for (const p of plans) p.tokens.forEach((t, i) => tokens.set(t, { symbol: p.symbols[i]!, decimals: p.decimals[i]! }));
  const symbolOf = (a: Address): string => tokens.get(a)?.symbol ?? a;
  const show = (a: Address, amount: bigint): string => `${units(amount, tokens.get(a)?.decimals ?? 0)} ${symbolOf(a)}`;
  console.log(`seeding ${plans.length} pools at ${units(USDG_PER_POOL, usdg.decimals)} ${usdg.symbol} a side, deployer ${deployer.address}`);
  for (const p of plans) console.log(`  pool ${p.id}: ${units(p.amounts[0], p.decimals[0])} ${p.symbols[0]} + ${units(p.amounts[1], p.decimals[1])} ${p.symbols[1]}`);

  const needs: Need[] = plans.flatMap((p) => [0, 1].map((side) => ({ pool: p.id, side: side as 0 | 1, asset: p.tokens[side]!, amount: p.amounts[side]! })));
  const lp = new LpWallet();
  const before = allocate(needs, await lp.notes());
  if (before.matched.size > 0) console.log(`reusing ${before.matched.size} unspent notes LP_SEED already holds`);
  console.log(`shielding ${before.missing.length} deposits`);
  const nextK = await shieldMissing(before.missing, symbolOf, show);
  const { matched, missing } = allocate(needs, await lp.notes());
  if (missing.length > 0) {
    throw new SeedError(`the LP wallet can't see ${missing.length} of its deposits after processing. Its scan stops after 20 unused indexes from 0, so START_K may be too far past its last deposit.`);
  }

  const [cx, cy, ax, ay, bx, by] = await Promise.all((["coordinatorX", "coordinatorY", "riskAX", "riskAY", "riskBX", "riskBY"] as const).map((functionName) => client.readContract({ address: deployment.pool, abi: poolAbi, functionName })));
  const coordinator = { x: cx!, y: cy! };
  const riskKeys = [{ x: ax!, y: ay! }, { x: bx!, y: by! }] as const;
  const provers = new Provers(PROVER_THREADS);
  const results: string[] = [];
  try {
    for (const p of plans) {
      const notes = [needs.find((n) => n.pool === p.id && n.side === 0)!, needs.find((n) => n.pool === p.id && n.side === 1)!].map((n) => matched.get(n)!);
      await lp.refresh();
      const payout = lp.nextPayout();
      const band = bandForDeposit(p.amounts[0], p.amounts[1], BAND_SLIPPAGE_BPS);
      // Ties the two locks together for the coordinator; random so it never matches another add's link.
      const link = BigInt(`0x${randomBytes(8).toString("hex")}`);
      const terms = lpBandTerms(p.id, link, band.lo, band.hi);
      const asOf = (await client.getBlock({ blockTag: "latest" })).timestamp;
      const expiry = asOf + LP_LOCK_TTL_S;
      const prove = async (side: 0 | 1, t: LockTerms): Promise<{ proof: Uint8Array; publicInputs: unknown }> => {
        const note = notes[side]!;
        const w = lockWitness({ keys: note.keys, deployment: deploymentId, tree: lp.tree, asset: BigInt(p.tokens[side]), inputs: [note], amount: p.amounts[side], terms: t, expiry, asOf, coordinator, riskKeys, payout: addressOf(payout), view: lp.main.pk });
        return { proof: (await (await provers.get("lock")).prove(w.inputs)).proof, publicInputs: w.publicInputs };
      };
      console.log(`pool ${p.id}: proving both LP locks`);
      const a = await prove(0, terms[0]);
      const b = await prove(1, terms[1]);
      const jobId = await submitRelay("lockPair", jsonBigint({ proof: [bytesToHex(a.proof), bytesToHex(b.proof)], publicInputs: [a.publicInputs, b.publicInputs] }));
      console.log(`pool ${p.id}: lockPair job ${jobId}`);
      const lockBlock = await waitJob(jobId);
      await waitProcessed(lockBlock, `pool ${p.id}'s LP locks`);
      const expected = lpAddOutcome(p.amounts[0], p.amounts[1], EMPTY_POOL);
      let shares: bigint;
      try {
        shares = await waitFor(`the coordinator to run pool ${p.id}'s add`, async () => {
          const seeded = (await getJson<{ pools: PoolRow[] }>(`${READ_URL}/v1/spot/pools`)).pools.find((r) => r.id === p.id.toString())?.seeded;
          return seeded ? lp.lpShares(payout) : null;
        }, ADD_TIMEOUT_MS);
      } catch (error) {
        throw new SeedError(`add not executed for pool ${p.id} (lockPair job ${jobId}). The locks refund to LP_SEED at expiry ${expiry}. ${error instanceof Error ? error.message : String(error)}`);
      }
      if (shares !== expected.shares) throw new SeedError(`pool ${p.id}: LP claim has ${shares} shares, an add of these amounts into an empty pool mints ${expected.shares}`);
      const line = `pool ${p.id} ${p.symbols[0]}/${p.symbols[1]}: amounts ${show(p.tokens[0], p.amounts[0])} + ${show(p.tokens[1], p.amounts[1])}, lockPair job ${jobId}, reserves r0=${expected.used0} r1=${expected.used1}, LP shares ${shares}, ${await quoteCheck(p)}`;
      console.log(line);
      results.push(line);
    }
  } finally {
    await provers.destroyAll();
  }
  console.log("\nseeded:");
  for (const line of results) console.log(`  ${line}`);
  console.log(`next free deposit index for LP_SEED: START_K=${nextK}`);
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(`seed-pools: ${error instanceof SeedError ? error.message : error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
}
