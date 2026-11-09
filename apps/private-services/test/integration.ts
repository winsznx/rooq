/**
 * Runs the services as separate OS processes on a dedicated anvil (8548) and drives a client lifecycle through their
 * HTTP APIs with real UltraHonk proofs. The client talks to the chain only for what a browser wallet does itself
 * (shielding from its own EOA). Prices, block time and reorgs are the test acting as the outside world.
 *
 *   pnpm --filter @rooq/private-services test:integration
 *
 * Writes docs/privacy/evidence/services-local.json. Anvil's public test keys and synthetic seeds only.
 */
import { tmpdir } from "node:os";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import {
  EMPTY_POOL, openPoolState, swapWitness, type PoolInfo, type PoolState,
  ACTOR_TAKER, addressOf, mulGenerator, PAIR_CT_RISK_A, amountOut, CLAIM_CT_LEN, CLAIM_CT_WINNER, CLOSE_TAKER, closeWitness, deriveKeys, exitRequestWitness, fillPrice, initCrypto, liquidationOutcome, lockAddressKeys, lockCommitment, lockWitness, MerkleTree, openClaim, openLp, openPair, PAIR_CT_LEN, pairCommitment, RECORD_LP, lpAddOutcome, lpSetWitness, lpTerms, LP_CT_LEN, swapTerms,
  PAIR_CT_TAKER, RECORD_CLAIM, RECORD_PAIR, recNullifier, redeemWitness, releaseWitness, spendWitness, takerTerms, toHex32, updateWitness,
  type ClaimRecord, type LockRecord, type LockTerms, type LpRecord, type PairRecord, type ShieldedDeposit, type WalletKeys,
} from "@rooq/private-sdk";
import { getAbiItem, parseAbi, toFunctionSelector, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { bytesToHex, loadPoolAbi, sleep } from "../src/lib/chain";
import { PORTS, REPO_ROOT } from "../src/lib/config";
import { isListening, LOCAL_RPC, LOCAL_RPC_PORT, LOCAL_SCALARS, LocalStack, localClients, shieldDeposits, writeJson, type LocalClients, type ServiceName } from "../src/lib/localstack";
import { Provers } from "../src/lib/provers";
import { ShieldedWallet, type WalletRecord } from "../src/lib/wallet";

const READ = `http://127.0.0.1:${PORTS.readApi}`;
const RELAY = `http://127.0.0.1:${PORTS.relayer}`;
const USD = 1_000_000n;
const FEE_NOTE = 500_000n;
const RELAYER_FEE_SEED = 0x7e1a1e4n;
const WAD = 10n ** 18n;
const ALICE_SEED = LOCAL_SCALARS.alice;
const SCRATCH = `${tmpdir()}/rooq-services-test-${process.pid}`;
const FORGE_OUT = process.env.FORGE_OUT ?? `${tmpdir()}/rooq-private-services-forge/out`;
const LOG_DIR = `${SCRATCH}/logs`;
const EVIDENCE = `${REPO_ROOT}docs/privacy/evidence/services-local.json`;
const CIRCUITS = `${SCRATCH}/circuits`;
mkdirSync(CIRCUITS, { recursive: true });
for (const f of readdirSync(`${REPO_ROOT}zk/circuits/target`)) copyFileSync(`${REPO_ROOT}zk/circuits/target/${f}`, `${CIRCUITS}/${f}`);
process.env.CIRCUITS_DIR = CIRCUITS;

interface Step { step: string; ok: boolean; ms: number; detail: unknown }
const steps: Step[] = [];

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  const t0 = performance.now();
  try {
    const detail = await fn();
    steps.push({ step: name, ok: true, ms: Math.round(performance.now() - t0), detail: detail ?? {} });
    console.log(`ok   ${name} (${Math.round(performance.now() - t0)} ms)`);
  } catch (error) {
    steps.push({ step: name, ok: false, ms: Math.round(performance.now() - t0), detail: { error: error instanceof Error ? error.message : String(error) } });
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function assert(cond: boolean, message: string, detail?: unknown): void {
  if (!cond) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`}`);
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(200);
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const health = (name: ServiceName): Promise<Record<string, unknown>> => {
  const port = name === "read-api" ? PORTS.readApi : name === "relayer" ? PORTS.relayer : name === "queue" ? PORTS.queue : name === "coordinator" ? PORTS.coordinator : name === "risk-a" ? PORTS.riskA : name === "risk-b" ? PORTS.riskB : PORTS.maker;
  return fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.json() as Promise<Record<string, unknown>>);
};
const counter = async (name: ServiceName, c: string): Promise<number> => {
  const counters = (await health(name)).counters as Record<string, number> | undefined;
  return counters?.[c] ?? 0;
};

interface SyncView { syncedBlock: string; head: string; processed: number; queueLength: number; root: Hex; rootSeq: string; reorgs: number }
interface MarketView { market: string; imrWad: string; mmrWad: string; penaltyBps: string; scale: string; takerFeeBps: string; funding: { index: string; lastEpoch: string; epochs: number }; markFresh: boolean; mark: string; maxPairSize: string; oiPending: string }

const syncView = (): Promise<SyncView> => getJson<SyncView>(`${READ}/v1/sync`);
const marketView = (id: bigint): Promise<MarketView> => getJson<MarketView>(`${READ}/v1/markets/${id}`);

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(LOCAL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** A single block goes through evm_mine so its timestamp follows the clock; anvil_mine can leave `latest` far behind it. */
const mine = (blocks = 1): Promise<unknown> => (blocks === 1 ? rpc("evm_mine") : rpc("anvil_mine", [`0x${blocks.toString(16)}`]));
const setAutomine = (on: boolean): Promise<unknown> => rpc("evm_setAutomine", [on]);
const warp = async (seconds: number): Promise<void> => {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine");
};

/** Waits until a pending transaction to the pool with this selector, from any of `from`, is in the mempool. */
async function waitInMempool(selector: Hex, pool: Address, count: number, what: string, timeoutMs = 180_000): Promise<number> {
  return waitFor(what, async () => {
    const content = await rpc<{ pending: Record<string, Record<string, { to?: string; input?: string }>> }>("txpool_content");
    let n = 0;
    for (const byNonce of Object.values(content.pending)) for (const tx of Object.values(byNonce)) if (tx.to?.toLowerCase() === pool.toLowerCase() && tx.input?.startsWith(selector)) n++;
    return n >= count ? n : null;
  }, timeoutMs);
}

// ---------------------------------------------------------------------------------------------------------------------
// The client: a browser wallet's flow, using only the read API and the relayer.
// ---------------------------------------------------------------------------------------------------------------------

interface RecordRow { leafIndex: number; kind: number; commitment: Hex; ciphertext: Hex[]; block: string }
interface DepositRow { leafIndex: number; asset: Hex; amount: string; inner: Hex; block: string }

async function pageAll<T>(url: string): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const page = await getJson<{ items: T[]; nextFrom: number | null }>(`${url}?from=${from}&limit=256`);
    out.push(...page.items);
    if (page.nextFrom === null) return out;
    from = page.nextFrom;
  }
}

interface HeldPair { pair: PairRecord; leafIndex: number; nullifier: bigint }

class Client {
  readonly wallet: ShieldedWallet;
  readonly main: WalletKeys;
  tree = new MerkleTree();
  processed = 0;
  records: WalletRecord[] = [];
  deposits: ShieldedDeposit[] = [];
  private usedPayouts = 0;

  constructor(readonly seed: bigint, readonly deployment: bigint, readonly provers: Provers, public coordinatorKey: { x: bigint; y: bigint }, readonly chainAsset: Address, public riskKeys: readonly [{ x: bigint; y: bigint }, { x: bigint; y: bigint }]) {
    this.wallet = new ShieldedWallet(seed, deployment);
    this.main = deriveKeys(seed);
  }

  async refresh(): Promise<void> {
    const rows = await pageAll<RecordRow>(`${READ}/v1/records`);
    this.records = rows.map((r) => ({ leafIndex: r.leafIndex, kind: r.kind, commitment: BigInt(r.commitment), ciphertext: r.ciphertext.map(BigInt) }));
    const deps = await pageAll<DepositRow>(`${READ}/v1/deposits`);
    this.deposits = deps.map((d) => ({ leafIndex: d.leafIndex, asset: BigInt(d.asset), amount: BigInt(d.amount), inner: BigInt(d.inner) }));
    const tree = new MerkleTree();
    let from = 0;
    for (;;) {
      const page = await getJson<{ leaves: Hex[]; processed: number }>(`${READ}/v1/tree/leaves?from=${from}&limit=512`);
      for (const leaf of page.leaves) tree.insert(BigInt(leaf));
      from += page.leaves.length;
      if (page.leaves.length === 0 || from >= page.processed) {
        this.processed = page.processed;
        break;
      }
    }
    this.tree = tree;
  }

  private async isSpent(nullifiers: bigint[]): Promise<boolean[]> {
    if (nullifiers.length === 0) return [];
    const out: boolean[] = [];
    for (let i = 0; i < nullifiers.length; i += 200) {
      const chunk = nullifiers.slice(i, i + 200).map(toHex32);
      const res = await getJson<{ spent: boolean[] }>(`${READ}/v1/nullifiers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nullifiers: chunk }) });
      out.push(...res.spent);
    }
    return out;
  }

  async notes(): Promise<ReturnType<ShieldedWallet["notes"]>> {
    await this.refresh();
    const all = this.wallet.notes(this.records, this.deposits, this.processed, () => false);
    const spent = await this.isSpent(all.map((n) => n.nullifier));
    return all.filter((_, i) => !spent[i]);
  }

  async noteOf(value: bigint) {
    const n = (await this.notes()).find((x) => x.value === value);
    assert(n !== undefined, `no note of ${value}`);
    return n!;
  }

  async placeLock(amount: bigint, terms: LockTerms, expiry: bigint, opts: { asset?: Address; payoutIndex?: number } = {}): Promise<{ jobId: string; body: string; record: LockRecord; payout: WalletKeys; held: { payoutIndex: number } }> {
    const notes = await this.notes();
    const lockAsset = BigInt(opts.asset ?? this.chainAsset);
    const note = [...notes].sort((a, b) => (a.value < b.value ? -1 : 1)).find((n) => n.asset === lockAsset && n.value >= amount);
    assert(note !== undefined, "no note covers the lock");
    const payoutIndex = opts.payoutIndex ?? Math.max(this.usedPayouts, this.wallet.usedAddresses(this.records).next);
    this.usedPayouts = Math.max(this.usedPayouts, payoutIndex + 1);
    const payout = lockAddressKeys(this.seed, payoutIndex);
    const w = lockWitness({ keys: note!.keys, deployment: this.deployment, tree: this.tree, asset: lockAsset, inputs: [note!], amount, terms, expiry, coordinator: this.coordinatorKey, riskKeys: this.riskKeys, payout: addressOf(payout), view: this.main.pk });
    const proof = await (await this.provers.get("lock")).prove(w.inputs);
    const body = JSON.stringify({ proof: bytesToHex(proof.proof), publicInputs: w.publicInputs }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    const jobId = await submitRelay("lock", body);
    return { jobId, body, record: w.record, payout, held: { payoutIndex } };
  }

  /** Latest unspent version of the pair on this one-time address. */
  async pairFor(payout: WalletKeys): Promise<HeldPair | null> {
    await this.refresh();
    const versions: HeldPair[] = [];
    for (const r of this.records) {
      if (r.kind !== RECORD_PAIR) continue;
      const pair = openPair(r.ciphertext.slice(PAIR_CT_TAKER * PAIR_CT_LEN, (PAIR_CT_TAKER + 1) * PAIR_CT_LEN), payout.encSk, this.deployment, r.commitment);
      if (pair) versions.push({ pair, leafIndex: r.leafIndex, nullifier: recNullifier(pairCommitment(this.deployment, pair), pair.recNonce) });
    }
    const spent = await this.isSpent(versions.map((v) => v.nullifier));
    return versions.filter((_, i) => !spent[i]).at(-1) ?? null;
  }

  async claimsFor(payout: WalletKeys): Promise<{ claim: ClaimRecord; leafIndex: number }[]> {
    await this.refresh();
    const out: { claim: ClaimRecord; leafIndex: number }[] = [];
    for (const r of this.records) {
      if (r.kind !== RECORD_CLAIM) continue;
      const claim = openClaim(r.ciphertext.slice(CLAIM_CT_WINNER * CLAIM_CT_LEN, (CLAIM_CT_WINNER + 1) * CLAIM_CT_LEN), payout.encSk, this.deployment, r.commitment);
      if (claim) out.push({ claim, leafIndex: r.leafIndex });
    }
    return out;
  }

  /** Unspent LP claims on this one-time address, oldest first. */
  async lpFor(payout: WalletKeys): Promise<{ claim: LpRecord; leafIndex: number; nullifier: bigint }[]> {
    await this.refresh();
    const found: { claim: LpRecord; leafIndex: number; nullifier: bigint }[] = [];
    for (const r of this.records) {
      if (r.kind !== RECORD_LP) continue;
      const claim = openLp(r.ciphertext.slice(0, LP_CT_LEN), payout.encSk, this.deployment, r.commitment);
      if (claim) found.push({ claim, leafIndex: r.leafIndex, nullifier: recNullifier(r.commitment, claim.recNonce) });
    }
    const spent = await this.isSpent(found.map((f) => f.nullifier));
    return found.filter((_, i) => !spent[i]);
  }

  async spent(nf: bigint): Promise<boolean> {
    return (await this.isSpent([nf]))[0] ?? false;
  }
}

async function submitRelay(action: string, body: string): Promise<string> {
  const res = await fetch(`${RELAY}/v1/relay/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const json = (await res.json()) as { id?: string; reasonCode?: string; message?: string };
  if (!res.ok || !json.id) throw new Error(`relay ${action}: ${res.status} ${json.reasonCode} ${json.message}`);
  return json.id;
}

async function waitJob(id: string, want: "confirmed" | "reorged" | "reverted" = "confirmed", timeoutMs = 120_000): Promise<Record<string, unknown>> {
  return waitFor(`job ${want}`, async () => {
    const job = await getJson<Record<string, unknown>>(`${RELAY}/v1/jobs/${id}`);
    if (job.status === want) return job;
    if (job.status === "reverted" && want !== "reverted") throw new Error(`job reverted: ${String(job.reasonCode)}`);
    return null;
  }, timeoutMs);
}

/** Funding and price are public inputs and a worker may settle funding first, so a wallet re-reads and re-proves. */
async function withReprove<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i >= attempts || !(error instanceof Error) || !/INVALID_PROOF|NULLIFIER_SPENT/.test(error.message)) throw error;
      await waitSynced();
    }
  }
}

const relayBody = (proof: Uint8Array, publicInputs: unknown): string => JSON.stringify({ proof: bytesToHex(proof), publicInputs }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

// ---------------------------------------------------------------------------------------------------------------------

const serviceEnv: Partial<Record<ServiceName, Record<string, string>>> = {
  "risk-a": { RISK_EPOCH_INTERVAL_S: "1800", RISK_FOLD_GAP_S: "2", RISK_STAGGER_S: "0", RISK_QUEUE_FALLBACK_MS: "12000", RECEIPT_TIMEOUT_MS: "15000", RISK_CLAIM_REDEEM_DELAY_S: "45", RISK_SPOT_TAKEOVER_S: "12", RISK_RELEASE_DELAY_S: "3600", SPOT_QUOTE_CACHE_MS: "0" },
  "risk-b": { RISK_EPOCH_INTERVAL_S: "1800", RISK_FOLD_GAP_S: "2", RISK_STAGGER_S: "6", RISK_QUEUE_FALLBACK_MS: "12000", RECEIPT_TIMEOUT_MS: "15000", RISK_CLAIM_REDEEM_DELAY_S: "45", RISK_SPOT_TAKEOVER_S: "12", RISK_RELEASE_DELAY_S: "3600", SPOT_QUOTE_CACHE_MS: "0" },
  relayer: { RELAYER_FINALITY_BLOCKS: "256", RELAYER_REBROADCAST_MS: "2000", RELAYER_FEE_SEED: "0x7e1a1e4" },
  coordinator: { RECEIPT_TIMEOUT_MS: "20000", COORDINATOR_RELEASE_DELAY_S: "900", SPOT_QUOTE_CACHE_MS: "0" },
  "read-api": { SPOT_QUOTE_PER_MINUTE: "600" },
};

const stack = new LocalStack({
  logDir: LOG_DIR,
  forgeOut: FORGE_OUT,
  // Its own file: the default one may belong to a stack another process is running.
  deploymentFile: `${REPO_ROOT}contracts/deployments/privacy-e2e-services-test.json`,
  inheritLogs: false,
  pollMs: 200,
  proverThreads: 2,
  circuitsDir: CIRCUITS,
  serviceEnv,
});

let c: LocalClients;
let abi: Abi;
let pool: Address;
let asset: Address;
let feed: Address;
let otherFeed: Address;
const proverRef: { current: Provers | null } = { current: null };
let alice: Client;
const feedAbi = parseAbi(["function setAnswer(int256)"]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const setPrice = async (usd: bigint, target: Address = feed): Promise<void> => {
  const hash = await c.wallet(stack.keys.deployer).writeContract({ address: target, abi: feedAbi, functionName: "setAnswer", args: [usd * 100_000_000n], chain: foundry });
  await c.client.waitForTransactionReceipt({ hash });
};
const blockTime = async (): Promise<bigint> => (await c.client.getBlock()).timestamp;

const waitSynced = (): Promise<SyncView> => waitFor("queue processed and read API at head", async () => {
  const s = await syncView();
  const head = await c.client.getBlockNumber({ cacheTime: 0 });
  return s.processed === s.queueLength && BigInt(s.syncedBlock) >= head ? s : null;
}, 120_000);

async function liveMakerLocks(atLeast: number): Promise<void> {
  await waitFor(`maker has ${atLeast} live locks`, async () => {
    const h = await health("maker");
    return Number(h.liveLocks) >= atLeast ? h : null;
  }, 120_000);
  await waitSynced();
}

/** A taker lock through the relayer, matched automatically, returned once the client can read its pair. */
async function openViaLock(market: bigint, amount: bigint, size: bigint, limit: bigint, isShort = false): Promise<{ pair: HeldPair; payout: WalletKeys; lockBody: string; jobId: string }> {
  await liveMakerLocks(1);
  const lock = await alice.placeLock(amount, takerTerms(market, isShort, size, limit), (await blockTime()) + 30n * 86_400n);
  await waitJob(lock.jobId);
  const pair = await waitFor("coordinator to match the lock", () => alice.pairFor(lock.payout), 180_000);
  await waitSynced();
  await alice.refresh();
  return { pair, payout: lock.payout, lockBody: lock.body, jobId: lock.jobId };
}

const lostRaces = async (): Promise<number> => (await counter("risk-a", "lostRaces")) + (await counter("risk-b", "lostRaces"));

async function main(): Promise<void> {
  await initCrypto();
  console.log(`logs: ${LOG_DIR}`);
  await stack.startAnvil();
  const d = await stack.deploy();
  c = localClients();
  abi = loadPoolAbi(FORGE_OUT);
  ({ pool, asset, feed, otherFeed } = d);
  proverRef.current = new Provers(2);
  const aliceEoa = privateKeyToAccount(stack.keys.alice).address;
  await shieldDeposits(c, stack.keys.deployer, stack.keys.maker, pool, asset, abi, LOCAL_SCALARS.maker, 0, Array.from({ length: 8 }, () => 1_000n * USD));
  await shieldDeposits(c, stack.keys.deployer, stack.keys.alice, pool, asset, abi, ALICE_SEED, 0, Array.from({ length: 12 }, () => 300n * USD));
  serviceEnv.relayer!.RELAYER_MIN_FEES = `${asset}:${FEE_NOTE}`;
  stack.startAll();
  const proverSet = proverRef.current;
  alice = new Client(ALICE_SEED, d.deploymentId, proverSet, await readCoordinator(), asset, await readRiskKeys());

  await step("all seven services start as separate OS processes and report healthy", async () => {
    const names: ServiceName[] = ["read-api", "relayer", "queue", "coordinator", "risk-a", "risk-b", "maker"];
    await Promise.all(names.map((n) => waitFor(`${n} healthy`, async () => (await health(n).catch(() => null))?.status === "ok", 180_000)));
    const pids = await Promise.all(names.map((n) => health(n).then((h) => Number(h.pid))));
    assert(new Set(pids).size === 7, "services must be separate processes", pids);
    return { pids: Object.fromEntries(names.map((n, i) => [n, pids[i]])) };
  });

  await step("the queue processor moves shielded deposits into the tree", async () => {
    const s = await waitSynced();
    assert(s.processed >= 20 && s.processed === s.queueLength, "the 20 deposits and any maker locks are processed", s);
    const chainRoot = (await c.client.readContract({ address: pool, abi, functionName: "root" })) as Hex;
    assert(chainRoot === s.root, "read API root equals chain root", { chainRoot, s });
    return { processed: s.processed, root: s.root };
  });

  let p1: Awaited<ReturnType<typeof openViaLock>>;
  await step("client locks through the relayer; the coordinator matches it against a maker lock at the mark plus spread", async () => {
    p1 = await openViaLock(1n, 150n * USD, 4n * WAD, 260n * WAD);
    assert(p1.pair.pair.entry === fillPrice(250n * WAD, 0n, 20n), "entry at mark +20 bps", p1.pair.pair.entry);
    await waitFor("coordinator to record its last action", async () => (await health("coordinator")).lastAction !== null || null, 10_000);
    await waitFor("workers to read the pair", async () => (Number((await health("risk-a")).pairsTracked) >= 1 && Number((await health("risk-b")).pairsTracked) >= 1) || null);
    return { entry: p1.pair.pair.entry, size: p1.pair.pair.size };
  });

  await step("price moves; a risk worker liquidates with the traders offline, and the owner recovers its output", async () => {
    const m = await marketView(1n);
    await setPrice(218n);
    await waitFor("liquidation to land", async () => (await alice.spent(p1.pair.nullifier)) || null, 120_000);
    await waitSynced();
    const o = liquidationOutcome(p1.pair.pair, 218n * WAD, BigInt(m.mmrWad), BigInt(m.penaltyBps), BigInt(m.scale), BigInt(m.funding.index));
    assert(o.takerBad && !o.makerBad, "reference model: taker unhealthy at 218", o);
    await alice.noteOf(o.takerOut);
    const liquidations = await waitFor("the landing worker to count it", async () => {
      const n = (await counter("risk-a", "liquidations")) + (await counter("risk-b", "liquidations"));
      return n === 1 ? n : null;
    }, 20_000);
    return { takerOut: o.takerOut, reward: o.reward, liquidations };
  });

  await step("a claim from a shortfall is redeemed through the relayer once its epoch has folded", async () => {
    await waitFor("funding fresh after the warp", async () => {
      const m = await marketView(1n);
      return BigInt(m.funding.lastEpoch) > (await blockTime()) - 3_500n || null;
    }, 120_000);
    await setPrice(100n);
    const p = await openViaLock(1n, 50n * USD, WAD, 110n * WAD);
    await setPrice(140n);
    await waitFor("maker-side liquidation", async () => (await alice.spent(p.pair.nullifier)) || null, 120_000);
    await waitSynced();
    const claimsWithAmount = await waitFor("non-zero claim", async () => {
      const claims = await alice.claimsFor(p.payout);
      return claims.find((x) => x.claim.amount > 0n) ?? null;
    });
    const ratio = await waitFor("the epoch to fold the claim", async () => {
      const r = await getJson<{ ratios: (string | null)[] }>(`${READ}/v1/claims/ratio`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deltaCommitments: [toHex32(claimsWithAmount.claim.deltaCm)] }) });
      return r.ratios[0] ?? null;
    }, 120_000);
    await alice.refresh();
    const w = redeemWitness({ claim: claimsWithAmount.claim, leafIndex: claimsWithAmount.leafIndex, deployment: d.deploymentId, tree: alice.tree, ratio: BigInt(ratio) });
    const proof = await (await proverSet.get("redeem_claim")).prove(w.inputs);
    await waitJob(await submitRelay("redeemClaim", relayBody(proof.proof, w.publicInputs)));
    await waitSynced();
    await alice.noteOf(w.value);
    return { claim: claimsWithAmount.claim.amount, ratio, paid: w.value };
  });

  await step("automatic claim redemption: an owner is paid with no action once a worker sees the folded ratio", async () => {
    await setPrice(100n);
    const big = await openViaLock(1n, 300n * USD, 10n * WAD, 110n * WAD);
    await setPrice(72n);
    await waitFor("funding the insurance", async () => (await alice.spent(big.pair.nullifier)) || null, 120_000);
    await waitSynced();
    await setPrice(100n);
    const p = await openViaLock(1n, 50n * USD, WAD, 110n * WAD);
    await setPrice(140n);
    await waitFor("claim-creating liquidation", async () => (await alice.spent(p.pair.nullifier)) || null, 120_000);
    await waitSynced();
    const claim = await waitFor("non-zero claim", async () => (await alice.claimsFor(p.payout)).find((x) => x.claim.amount > 0n) ?? null, 120_000);
    const ratio = await waitFor("fold", async () => {
      const r = await getJson<{ ratios: (string | null)[] }>(`${READ}/v1/claims/ratio`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deltaCommitments: [toHex32(claim.claim.deltaCm)] }) });
      return r.ratios[0] ?? null;
    }, 120_000);
    const expected = (claim.claim.amount * BigInt(ratio)) / WAD;
    assert(expected > 0n, "the claim pays something");
    await waitFor("automatic payout", async () => (await alice.notes()).some((n) => n.value === expected) || null, 180_000);
    const redeemed = await waitFor("worker to count the redemption", async () => {
      const n = (await counter("risk-a", "claimsRedeemed")) + (await counter("risk-b", "claimsRedeemed"));
      return n >= 1 ? n : null;
    }, 20_000);
    await setPrice(100n);
    return { claim: claim.claim.amount, paid: expected, claimsRedeemed: redeemed };
  });

  await step("a real mempool race: both workers submit the same liquidation, the shared nullifier refuses one, and neither stops", async () => {
    await setPrice(100n);
    await waitFor("funding head usable", async () => true);
    const p = await openViaLock(1n, 40n * USD, 2n * WAD, 110n * WAD);
    const before = await lostRaces();
    await setAutomine(false);
    await c.wallet(stack.keys.deployer).writeContract({ address: feed, abi: feedAbi, functionName: "setAnswer", args: [80n * 100_000_000n], chain: foundry });
    await mine(1);
    const selector = toFunctionSelector(getAbiItem({ abi, name: "liquidate" }) as Parameters<typeof toFunctionSelector>[0]);
    // Anvil estimates gas against pending state, so the slower worker is usually refused at estimation rather than in a block.
    const inPool = await waitFor("a liquidation in the mempool and the other worker refused or queued", async () => {
      const n = await waitInMempool(selector, pool, 1, "a liquidation in the mempool");
      return n >= 2 || (await lostRaces()) > before ? n : null;
    }, 180_000);
    await mine(1);
    await setAutomine(true);
    await mine(1);
    await waitFor("race resolved", async () => ((await lostRaces()) > before && (await alice.spent(p.pair.nullifier))) || null, 60_000);
    await waitSynced();
    const healthA = await health("risk-a");
    const healthB = await health("risk-b");
    assert(healthA.status === "ok" && healthB.status === "ok", "both workers stay healthy after the lost race", { healthA, healthB });
    return { inPool, lostRaces: await lostRaces() };
  });

  await step("price moves under the coordinator's proof: it re-proves at the new price and the pair opens", async () => {
    await setPrice(100n);
    await liveMakerLocks(1);
    const before = await counter("coordinator", "reproved");
    await setAutomine(false);
    const lock = await alice.placeLock(40n * USD, takerTerms(1n, false, WAD, 130n * WAD), (await blockTime()) + 30n * 86_400n);
    await mine(1);
    await waitJob(lock.jobId);
    const selector = toFunctionSelector(getAbiItem({ abi, name: "openPair" }) as Parameters<typeof toFunctionSelector>[0]);
    const selectorQueue = toFunctionSelector(getAbiItem({ abi, name: "processQueue" }) as Parameters<typeof toFunctionSelector>[0]);
    await waitInMempool(selectorQueue, pool, 1, "queue processor batch in the mempool");
    await mine(1);
    await waitInMempool(selector, pool, 1, "coordinator's openPair in the mempool");
    const hash = await c.wallet(stack.keys.deployer).writeContract({ address: feed, abi: feedAbi, functionName: "setAnswer", args: [101n * 100_000_000n], chain: foundry, maxPriorityFeePerGas: 100_000_000_000n, maxFeePerGas: 400_000_000_000n });
    await mine(1);
    await setAutomine(true);
    await mine(1);
    await c.client.waitForTransactionReceipt({ hash });
    const opened = await waitFor("re-proved open to land", () => alice.pairFor(lock.payout), 180_000);
    assert(opened.pair.entry === fillPrice(101n * WAD, 0n, 20n), "entry reflects the moved price", opened.pair.entry);
    assert((await counter("coordinator", "reproved")) > before, "coordinator counted a re-proof");
    return { entry: opened.pair.entry, reproved: await counter("coordinator", "reproved") };
  });

  await step("worker A is killed mid-run; worker B liquidates alone", async () => {
    await setPrice(100n);
    // Margin is set so this liquidation pays a penalty into insurance, which the later claim step draws on.
    const p = await openViaLock(1n, 50n * USD, WAD, 110n * WAD);
    await waitSynced();
    await stack.stop("risk-a", "SIGKILL");
    assert(!(await isListening(PORTS.riskA)), "worker A is really down");
    const before = await counter("risk-b", "liquidations");
    await setPrice(52n);
    await waitFor("worker B to liquidate", async () => (await alice.spent(p.pair.nullifier)) || null, 120_000);
    await waitFor("worker B to count its liquidation", async () => (await counter("risk-b", "liquidations")) >= before + 1 || null, 20_000);
    await setPrice(100n);
    return { riskB: await counter("risk-b", "liquidations") };
  });

  await step("the queue service is killed; a risk worker's fallback keeps the tree moving", async () => {
    await waitSynced();
    await stack.stop("queue", "SIGKILL");
    const before = (await syncView()).processed;
    await shieldDeposits(c, stack.keys.deployer, stack.keys.alice, pool, asset, abi, ALICE_SEED, 12, [25n * USD]);
    await waitFor("risk fallback to process the queue", async () => ((await syncView()).processed > before) || null, 60_000);
    await waitFor("worker B to count its queue fallback batch", async () => (await counter("risk-b", "queueFallbackBatches")) >= 1 || null, 20_000);
    stack.start("queue");
    await waitFor("queue healthy", async () => (await health("queue").catch(() => null))?.status === "ok", 60_000);
    return { fallbackBatches: await counter("risk-b", "queueFallbackBatches") };
  });

  await step("worker A restarts with no local state and rebuilds the same view from chain plus its key", async () => {
    await waitSynced();
    stack.start("risk-a");
    await waitFor("worker A healthy", async () => (await health("risk-a").catch(() => null))?.status === "ok", 60_000);
    await waitFor("worker A caught up", async () => {
      const [a, b] = await Promise.all([health("risk-a"), health("risk-b")]);
      return a.pairsTracked === b.pairsTracked && a.claimsTracked === b.claimsTracked ? a : null;
    }, 30_000);
    const a = await health("risk-a");
    const b = await health("risk-b");
    return { pairsTracked: a.pairsTracked, claimsTracked: a.claimsTracked, sameAsB: a.pairsTracked === b.pairsTracked };
  });

  let p5: Awaited<ReturnType<typeof openViaLock>> | null = null;
  await step("the coordinator restarts with no state and matches a lock placed while it was down", async () => {
    await waitSynced();
    await stack.stop("coordinator", "SIGKILL");
    await liveMakerLocks(1);
    const lock = await alice.placeLock(60n * USD, takerTerms(1n, false, WAD, 110n * WAD), (await blockTime()) + 30n * 86_400n);
    await waitJob(lock.jobId);
    await waitSynced();
    stack.start("coordinator");
    const pair = await waitFor("match after restart", () => alice.pairFor(lock.payout), 180_000);
    p5 = { pair, payout: lock.payout, lockBody: lock.body, jobId: lock.jobId };
    return { entry: pair.pair.entry };
  });

  await step("the read API and relayer restart with no state: the read API rebuilds, the relayer recovers jobs from the chain", async () => {
    await waitSynced();
    const job = await getJson<Record<string, unknown>>(`${RELAY}/v1/jobs/${p5!.jobId}`);
    assert(job.status === "confirmed", "job confirmed before restart", job);
    await stack.stop("read-api", "SIGKILL");
    await stack.stop("relayer", "SIGKILL");
    stack.start("read-api");
    stack.start("relayer");
    await waitFor("read API healthy", async () => (await health("read-api").catch(() => null))?.status === "ok", 60_000);
    await waitFor("relayer healthy", async () => (await health("relayer").catch(() => null))?.status === "ok", 60_000);
    const chainRoot = (await c.client.readContract({ address: pool, abi, functionName: "root" })) as Hex;
    const s = await waitSynced();
    assert(s.root === chainRoot, "read API root equals chain after restart", { s, chainRoot });
    const recovered = await waitFor("recovered job", async () => {
      const j = await fetch(`${RELAY}/v1/jobs/${p5!.jobId}`);
      return j.ok ? (await j.json()) as Record<string, unknown> : null;
    }, 30_000);
    assert(recovered.status === "confirmed" && recovered.tx === job.tx, "same job, same transaction, recovered from chain", recovered);
    const repost = await fetch(`${RELAY}/v1/relay/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: p5!.lockBody });
    const repostBody = (await repost.json()) as { id: string; status: string };
    assert(repost.status === 200 && repostBody.id === job.id && repostBody.status === "confirmed", "an identical request after restart is the same job", repostBody);
    return { recoveredTx: recovered.tx };
  });

  await step("funding: epochs advance from the workers, a worker settles funding on the open pair with no owner key", async () => {
    await waitSynced();
    const before = await marketView(1n);
    const lock = await alice.notes();
    await warp(3_700);
    await setPrice(100n);
    await waitFor("funding index to move", async () => {
      const m = await marketView(1n);
      return (BigInt(m.funding.index) !== BigInt(before.funding.index) && m.funding.epochs > before.funding.epochs) || null;
    }, 120_000);
    const settled = await waitFor("worker to settle funding on the pair", async () => {
      const pair = await alice.pairFor(p5!.payout);
      return pair && pair.pair.fundingIndex !== p5!.pair.pair.fundingIndex ? pair : null;
    }, 120_000);
    assert(settled.pair.takerMargin < p5!.pair.pair.takerMargin, "taker paid accrued funding as a pair update", { before: p5!.pair.pair.takerMargin, after: settled.pair.takerMargin });
    p5 = { ...p5!, pair: settled };
    await setPrice(100n);
    return { notesBefore: lock.length, fundingIndex: settled.pair.fundingIndex, takerMarginAfter: settled.pair.takerMargin };
  });

  await step("the taker adds margin through the relayer", async () => {
    await waitSynced();
    const { w, current } = await withReprove(async () => {
    const m = await marketView(1n);
    const current = (await alice.pairFor(p5!.payout))!;
    const note = await alice.notes().then((ns) => ns.find((n) => n.asset === BigInt(asset) && n.value >= 5n * USD && n.keys.pk.x === alice.main.pk.x));
    assert(note !== undefined, "a main-address note to add from");
    const w = updateWitness({
      pair: current.pair, leafIndex: current.leafIndex, deployment: d.deploymentId, tree: alice.tree, update: { actor: ACTOR_TAKER, add: 5n * USD, remove: 0n, reduce: 0n }, sk: p5!.payout.sk, noteOwner: note!.keys, note: note!,
      mark: BigInt(m.mark), imrWad: BigInt(m.imrWad), scale: BigInt(m.scale), feeBps: BigInt(m.takerFeeBps), fundingIndex: BigInt(m.funding.index), riskKeys: await readRiskKeys(), feeTo: await readFeeTo(),
    });
    const proof = await (await proverSet.get("pair_update")).prove(w.inputs);
    const job = await submitRelay("updatePair", relayBody(proof.proof, w.publicInputs));
    await waitJob(job);
    return { w, current };
    });
    const after = await waitFor("new pair version", async () => {
      const x = await alice.pairFor(p5!.payout);
      return x && x.pair.recNonce !== current.pair.recNonce ? x : null;
    });
    assert(after.pair.takerMargin === w.record.takerMargin && after.pair.takerMargin > current.pair.takerMargin, "margin is what the independent model says after funding plus the added amount", { after: after.pair.takerMargin, want: w.record.takerMargin });
    p5 = { ...p5!, pair: after };
    return { takerMargin: after.pair.takerMargin };
  });

  await step("the taker closes through the relayer at the mark less the committed spread, and is paid", async () => {
    await waitSynced();
    await setPrice(110n);
    const w = await withReprove(async () => {
    const m = await marketView(1n);
    const current = (await alice.pairFor(p5!.payout))!;
    const w = closeWitness({ pair: current.pair, leafIndex: current.leafIndex, deployment: d.deploymentId, tree: alice.tree, mode: CLOSE_TAKER, mark: 110n * WAD, scale: BigInt(m.scale), fundingIndex: BigInt(m.funding.index), sk: p5!.payout.sk, feeBps: BigInt(m.takerFeeBps), feeTo: await readFeeTo() });
    const proof = await (await proverSet.get("close_pair")).prove(w.inputs);
    await waitJob(await submitRelay("closePair", relayBody(proof.proof, w.publicInputs)));
    return w;
    });
    await waitSynced();
    await alice.noteOf(w.outcome.takerOut);
    return { takerOut: w.outcome.takerOut, makerOut: w.outcome.makerOut };
  });

  await step("a forced exit: the owner requests it through the relayer and, after the delay, a worker closes it with nobody online", async () => {
    await setPrice(100n);
    const p = await openViaLock(1n, 40n * USD, WAD, 110n * WAD);
    const w = exitRequestWitness({ pair: p.pair.pair, leafIndex: p.pair.leafIndex, deployment: d.deploymentId, tree: alice.tree, sk: p.payout.sk });
    const proof = await (await proverSet.get("exit_request")).prove(w.inputs);
    await waitJob(await submitRelay("requestExit", relayBody(proof.proof, { root: w.root, nullifier: w.nullifier })));
    await waitFor("exit recorded on the read API", async () => {
      const r = await getJson<{ exits: ({ matureAt: string } | null)[] }>(`${READ}/v1/exits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nullifiers: [w.nullifier] }) });
      return r.exits[0] ?? null;
    });
    await warp(7 * 86_400 + 120);
    await setPrice(90n);
    await waitFor("a worker to close the matured exit", async () => (await alice.spent(p.pair.nullifier)) || null, 180_000);
    await waitSynced();
    const forced = await waitFor("exactly one forced close to be counted", async () => {
      const n = (await counter("risk-a", "forcedCloses")) + (await counter("risk-b", "forcedCloses"));
      return n === 1 ? n : null;
    }, 20_000);
    return { forcedCloses: forced };
  });

  await step("an unmatched lock is released after expiry through the relayer, and a note is spent and withdrawn through it", async () => {
    await waitSynced();
    const now = await blockTime();
    const parked = await alice.placeLock(7n * USD, takerTerms(1n, false, WAD, 1n), now + 120n);
    await waitJob(parked.jobId);
    await waitSynced();
    await warp(400);
    await waitSynced();
    await alice.refresh();
    const held = alice.wallet.ownLocks(alice.records).find((l) => l.record.recNonce === parked.record.recNonce);
    assert(held !== undefined, "the client finds its own lock");
    const rel = releaseWitness({ held: held!, deployment: d.deploymentId, tree: alice.tree, asOf: await blockTime() });
    const relProof = await (await proverSet.get("release")).prove(rel.inputs);
    await waitJob(await submitRelay("release", relayBody(relProof.proof, rel.publicInputs)));
    await waitSynced();
    await alice.noteOf(7n * USD);

    const note = (await alice.notes()).find((n) => n.asset === BigInt(asset) && n.value >= 12n * USD && n.keys.pk.x === alice.main.pk.x);
    assert(note !== undefined, "a main-address note to spend");
    const tokenBefore = await c.client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [aliceEoa] });
    const relayerInfo = await getJson<{ address: { auth: string; pk: { x: string; y: string } } }>(`${RELAY}/v1/relayer`);
    const feeTo = { auth: BigInt(relayerInfo.address.auth), pk: { x: BigInt(relayerInfo.address.pk.x), y: BigInt(relayerInfo.address.pk.y) } };
    const noFee = spendWitness({ keys: note!.keys, deployment: d.deploymentId, tree: alice.tree, asset: BigInt(asset), inputs: [note!], outputs: [{ value: note!.value - 11n * USD, to: addressOf(alice.main) }], withdraw: { amount: 11n * USD, recipient: BigInt(aliceEoa) } });
    const noFeeProof = await (await proverSet.get("spend")).prove(noFee.inputs);
    const refused = await fetch(`${RELAY}/v1/relay/spend`, { method: "POST", headers: { "content-type": "application/json" }, body: relayBody(noFeeProof.proof, noFee.publicInputs) });
    const refusedBody = (await refused.json()) as { reasonCode: string };
    assert(refused.status === 402 && refusedBody.reasonCode === "RELAYER_FEE_REQUIRED", "a spend without a fee note is refused by name", { status: refused.status, refusedBody });
    const spendFee = spendWitness({ keys: note!.keys, deployment: d.deploymentId, tree: alice.tree, asset: BigInt(asset), inputs: [note!], outputs: [{ value: note!.value - 11n * USD - FEE_NOTE, to: addressOf(alice.main) }, { value: 0n, to: addressOf(alice.main) }, { value: FEE_NOTE, to: feeTo }], withdraw: { amount: 11n * USD, recipient: BigInt(aliceEoa) } });
    const spendProof = await (await proverSet.get("spend")).prove(spendFee.inputs);
    await waitJob(await submitRelay("spend", relayBody(spendProof.proof, spendFee.publicInputs)));
    const relayerWallet = new ShieldedWallet(RELAYER_FEE_SEED, d.deploymentId);
    await waitFor("the relayer's fee note, spendable from its own seed", async () => {
      await alice.refresh();
      const feeNotes = relayerWallet.notes(alice.records, alice.deposits, alice.processed, () => false);
      return feeNotes.some((n) => n.value === FEE_NOTE && n.asset === BigInt(asset)) || null;
    }, 60_000);
    const tokenAfter = await c.client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [aliceEoa] });
    assert(tokenAfter - tokenBefore === 11n * USD, "withdrawal paid to the recipient", { tokenBefore, tokenAfter });
    return { released: 7n * USD, withdrawn: 11n * USD };
  });

  const aliceKStart = 13;
  const [tokenA, tokenB] = d.spotTokens as [Address, Address];
  await shieldDeposits(c, stack.keys.deployer, stack.keys.alice, pool, asset, abi, ALICE_SEED, aliceKStart, [12_000n * USD, 6_000n * USD, 2_000n * USD, 1_000n * USD]);
  await shieldDeposits(c, stack.keys.deployer, stack.keys.alice, pool, tokenA, abi, ALICE_SEED, aliceKStart + 4, [1_500n * WAD, 1_500n * WAD, 1_000n * WAD, 500n * WAD]);
  await shieldDeposits(c, stack.keys.deployer, stack.keys.alice, pool, tokenB, abi, ALICE_SEED, aliceKStart + 8, [2_500n * WAD, 800n * WAD]);
  const model = new Map<bigint, { r0: bigint; r1: bigint; supply: bigint }>([[1n, { r0: 0n, r1: 0n, supply: 0n }], [2n, { r0: 0n, r1: 0n, supply: 0n }]]);
  const FEE_BPS = 30n;
  const LP_EXPIRY = async (): Promise<bigint> => (await blockTime()) + 86_400n;
  const noteArrives = async (assetAddr: Address, value: bigint): Promise<void> => {
    await waitSynced();
    await waitFor(`note of ${value}`, async () => (await alice.notes()).some((n) => n.asset === BigInt(assetAddr) && n.value === value) || null, 90_000);
  };
  const spotPayouts: WalletKeys[] = [];
  const quote = (body: unknown): Promise<{ amountOut: string; priceImpactBps: number; hops: number }> => getJson(`${READ}/v1/spot/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const lpLocks = async (poolId: bigint, token0: Address, amount0: bigint, token1: Address, amount1: bigint, link: bigint): Promise<WalletKeys> => {
    await waitSynced();
    const a = await alice.placeLock(amount0, lpTerms(poolId, 0n, 1n, link), await LP_EXPIRY(), { asset: token0 });
    await waitJob(a.jobId);
    await waitSynced();
    const b = await alice.placeLock(amount1, lpTerms(poolId, 1n, 1n, link), await LP_EXPIRY(), { asset: token1, payoutIndex: a.held.payoutIndex });
    await waitJob(b.jobId);
    await waitSynced();
    return a.payout;
  };
  const doSwap = async (poolId: bigint, second: bigint, assetIn: Address, assetOut: Address, amount: bigint, minOut: bigint, expirySeconds = 3_600n): Promise<{ payout: WalletKeys; out: bigint; leaf: { record: LockRecord } }> => {
    let amountOutModel = amount;
    let cur: bigint = BigInt(assetIn);
    for (const id of [poolId, ...(second !== 0n ? [second] : [])]) {
      const p = model.get(id)!;
      const tokens = id === 1n ? [BigInt(asset), BigInt(tokenA)] : [BigInt(tokenA), BigInt(tokenB)];
      const zeroForOne = cur === tokens[0];
      const [rIn, rOut] = zeroForOne ? [p.r0, p.r1] : [p.r1, p.r0];
      const out = amountOut(amountOutModel, rIn, rOut, FEE_BPS);
      if (zeroForOne) { p.r0 += amountOutModel; p.r1 -= out; } else { p.r1 += amountOutModel; p.r0 -= out; }
      amountOutModel = out;
      cur = zeroForOne ? tokens[1]! : tokens[0]!;
    }
    assert(cur === BigInt(assetOut), "the route ends in the expected token");
    const lock = await alice.placeLock(amount, swapTerms(poolId, minOut, second), (await blockTime()) + expirySeconds, { asset: assetIn });
    await waitJob(lock.jobId);
    spotPayouts.push(lock.payout);
    return { payout: lock.payout, out: amountOutModel, leaf: { record: lock.record } };
  };

  await step("spot: the coordinator seeds both pools from linked LP locks submitted through the relayer", async () => {
    const payout1 = await lpLocks(1n, asset, 10_000n * USD, tokenA, 1_000n * WAD, 1_001n);
    await waitFor("pool 1 seeded", async () => (await getJson<{ pools: { id: string; seeded: boolean }[] }>(`${READ}/v1/spot/pools`)).pools.find((p) => p.id === "1")?.seeded || null, 120_000);
    const o1 = lpAddOutcome(10_000n * USD, 1_000n * WAD, { r0: 0n, r1: 0n, supply: 0n, lastLeaf: 0n, blind: 0n });
    model.set(1n, { r0: o1.used0, r1: o1.used1, supply: o1.supply });
    await waitFor("LP claim", async () => (await alice.lpFor(payout1)).length === 1 || null, 60_000);
    const payout2 = await lpLocks(2n, tokenA, 1_000n * WAD, tokenB, 2_000n * WAD, 1_002n);
    await waitFor("pool 2 seeded", async () => (await getJson<{ pools: { id: string; seeded: boolean }[] }>(`${READ}/v1/spot/pools`)).pools.find((p) => p.id === "2")?.seeded || null, 120_000);
    const o2 = lpAddOutcome(1_000n * WAD, 2_000n * WAD, { r0: 0n, r1: 0n, supply: 0n, lastLeaf: 0n, blind: 0n });
    model.set(2n, { r0: o2.used0, r1: o2.used1, supply: o2.supply });
    await waitFor("second LP claim", async () => (await alice.lpFor(payout2)).length === 1 || null, 60_000);
    spotPayouts.push(payout1, payout2);
    return { pool1Shares: (await alice.lpFor(payout1))[0]!.claim.shares, pool2Shares: (await alice.lpFor(payout2))[0]!.claim.shares };
  });

  await step("spot: the quote gives an executable estimate and price impact, rounded down, without the reserves", async () => {
    const q = await quote({ pool: "1", assetIn: asset, amountIn: (100n * USD).toString() });
    const exact = amountOut(100n * USD, model.get(1n)!.r0, model.get(1n)!.r1, FEE_BPS);
    const got = BigInt(q.amountOut);
    assert(got <= exact && got > (exact * 99n) / 100n, "quote is rounded down within 1 percent of the fill", { got, exact });
    assert(q.priceImpactBps >= 90 && q.priceImpactBps <= 110, "impact matches a 1 percent order against this depth", { q });
    assert(Object.keys(q).sort().join(",") === "amountOut,hops,indicative,pool,priceImpactBps,secondPool", "the response carries only the estimate and impact", Object.keys(q));
    return { amountOut: q.amountOut, priceImpactBps: q.priceImpactBps, exact };
  });

  await step("spot: a swap fills against the private pool and pays a shielded note", async () => {
    const { out, payout } = await doSwap(1n, 0n, asset, tokenA, 100n * USD, 1n);
    await noteArrives(tokenA, out);
    assert((await counter("coordinator", "spot_swap")) >= 1, "the coordinator executed it");
    return { out, payout: payout.pk.x.toString(16).slice(0, 8) };
  });

  await step("spot: a two-hop swap settles through both pools atomically", async () => {
    const { out } = await doSwap(1n, 2n, asset, tokenB, 200n * USD, 1n);
    await noteArrives(tokenB, out);
    return { out, swaps: await counter("coordinator", "spot_swap") };
  });

  await step("spot: LP add then removal through a signed request pays out both tokens", async () => {
    const before = await counter("coordinator", "spot_add");
    const payout = await lpLocks(1n, asset, 5_000n * USD, tokenA, 1_000n * WAD, 1_003n);
    await waitFor("add executed", async () => (await counter("coordinator", "spot_add")) > before || null, 90_000);
    const m = model.get(1n)!;
    const outcome = lpAddOutcome(5_000n * USD, 1_000n * WAD, { r0: m.r0, r1: m.r1, supply: m.supply, lastLeaf: 0n, blind: 0n });
    model.set(1n, { r0: m.r0 + outcome.used0, r1: m.r1 + outcome.used1, supply: outcome.supply });
    const [lp] = await waitFor("LP claim", async () => {
      const list = await alice.lpFor(payout);
      return list.length === 1 ? list : null;
    }, 60_000);
    assert(lp!.claim.shares === outcome.shares, "minted shares match the model", { got: lp!.claim.shares, want: outcome.shares });
    await waitSynced();
    await alice.refresh();
    const keys: readonly [{ x: bigint; y: bigint }, { x: bigint; y: bigint }, { x: bigint; y: bigint }] = [alice.coordinatorKey, ...(await readRiskKeys())];
    const w = lpSetWitness({ claim: lp!.claim, leafIndex: lp!.leafIndex, deployment: d.deploymentId, tree: alice.tree, mode: 0n, sk: payout.sk, min0: 1n, min1: 1n, expiry: await LP_EXPIRY(), asOf: await blockTime(), keys });
    const proof = await (await proverSet.get("lp_set")).prove(w.inputs);
    const beforeRemove = await counter("coordinator", "spot_remove");
    await waitJob(await submitRelay("setLiquidityRequest", relayBody(proof.proof, w.publicInputs)));
    await waitFor("removal executed", async () => (await counter("coordinator", "spot_remove")) > beforeRemove || null, 90_000);
    const m2 = model.get(1n)!;
    const out0 = (lp!.claim.shares * m2.r0) / m2.supply;
    const out1 = (lp!.claim.shares * m2.r1) / m2.supply;
    model.set(1n, { r0: m2.r0 - out0, r1: m2.r1 - out1, supply: m2.supply - lp!.claim.shares });
    await noteArrives(asset, out0);
    await noteArrives(tokenA, out1);
    return { shares: lp!.claim.shares, out0, out1 };
  });

  await step("spot: an unfillable intent is left to expire with a logged reason and is then released to its owner", async () => {
    await waitSynced();
    const before = await counter("coordinator", "locksReleased");
    const lock = await alice.placeLock(50n * USD, swapTerms(1n, 10n ** 24n, 0n), (await blockTime()) + 60n, { asset });
    await waitJob(lock.jobId);
    await waitSynced();
    await waitFor("skip logged", async () => readFileSync(`${LOG_DIR}/coordinator.log`, "utf8").includes('"reason":"BELOW_MIN_OUT"') || null, 30_000);
    await warp(1_100);
    await setPrice(100n);
    await waitFor("release", async () => (await counter("coordinator", "locksReleased")) > before || null, 60_000);
    await noteArrives(asset, 50n * USD);
    return { locksReleased: await counter("coordinator", "locksReleased") };
  });

  await step("spot: an ignored removal request returns to idle automatically (lp_set mode 1) with no key", async () => {
    await waitSynced();
    const payout = await lpLocks(1n, asset, 2_000n * USD, tokenA, 200n * WAD, 1_004n);
    const [lp] = await waitFor("LP claim", async () => {
      const list = await alice.lpFor(payout);
      return list.length === 1 ? list : null;
    }, 90_000);
    const m = model.get(1n)!;
    const outcome = lpAddOutcome(2_000n * USD, 200n * WAD, { r0: m.r0, r1: m.r1, supply: m.supply, lastLeaf: 0n, blind: 0n });
    model.set(1n, { r0: m.r0 + outcome.used0, r1: m.r1 + outcome.used1, supply: outcome.supply });
    await waitSynced();
    await alice.refresh();
    const keys: readonly [{ x: bigint; y: bigint }, { x: bigint; y: bigint }, { x: bigint; y: bigint }] = [alice.coordinatorKey, ...(await readRiskKeys())];
    const w = lpSetWitness({ claim: lp!.claim, leafIndex: lp!.leafIndex, deployment: d.deploymentId, tree: alice.tree, mode: 0n, sk: payout.sk, min0: 10n ** 24n, min1: 1n, expiry: (await blockTime()) + 60n, asOf: await blockTime(), keys });
    const proof = await (await proverSet.get("lp_set")).prove(w.inputs);
    await waitJob(await submitRelay("setLiquidityRequest", relayBody(proof.proof, w.publicInputs)));
    await waitSynced();
    await warp(120);
    await setPrice(100n);
    await waitFor("request back to idle", async () => (await alice.lpFor(payout)).find((x) => x.claim.expiry === 0n && x.claim.recNonce !== lp!.claim.recNonce) || null, 90_000);
    const idled = (await counter("coordinator", "lpRequestsIdled")) + (await counter("risk-a", "lpRequestsIdled")) + (await counter("risk-b", "lpRequestsIdled"));
    assert(idled >= 1, "a service returned the expired request to idle");
    return { idled };
  });

  const spotSum = async (name: string): Promise<number> => (await counter("risk-a", name)) + (await counter("risk-b", name));

  await step("spot failover: with the coordinator killed, risk workers take over by themselves using only their own keys", async () => {
    await waitSynced();
    await stack.stop("coordinator", "SIGKILL");
    assert(!(await isListening(PORTS.coordinator)), "the coordinator is really down");

    const q = await quote({ pool: "1", assetIn: asset, amountIn: (10n * USD).toString() });
    assert(BigInt(q.amountOut) > 0n, "quote served without the coordinator");

    const swapBefore = await spotSum("spot_swap");
    const { out: swapOut } = await doSwap(1n, 0n, asset, tokenA, 30n * USD, 1n);
    await noteArrives(tokenA, swapOut);
    await waitFor("a worker to count the swap", async () => (await spotSum("spot_swap")) > swapBefore || null, 30_000);

    const addBefore = await spotSum("spot_add");
    const payout = await lpLocks(2n, tokenA, 400n * WAD, tokenB, 800n * WAD, 1_005n);
    await waitFor("a worker to execute the LP add", async () => (await spotSum("spot_add")) > addBefore || null, 120_000);
    const [lp] = await waitFor("LP claim", async () => {
      const list = await alice.lpFor(payout);
      return list.length === 1 ? list : null;
    }, 90_000);
    const m = model.get(2n)!;
    const added = lpAddOutcome(400n * WAD, 800n * WAD, { r0: m.r0, r1: m.r1, supply: m.supply, lastLeaf: 0n, blind: 0n });
    model.set(2n, { r0: m.r0 + added.used0, r1: m.r1 + added.used1, supply: added.supply });
    assert(lp!.claim.shares === added.shares, "shares match the model", { got: lp!.claim.shares, want: added.shares });

    await waitSynced();
    await alice.refresh();
    const keys: readonly [{ x: bigint; y: bigint }, { x: bigint; y: bigint }, { x: bigint; y: bigint }] = [alice.coordinatorKey, ...(await readRiskKeys())];
    const set = lpSetWitness({ claim: lp!.claim, leafIndex: lp!.leafIndex, deployment: d.deploymentId, tree: alice.tree, mode: 0n, sk: payout.sk, min0: 1n, min1: 1n, expiry: await LP_EXPIRY(), asOf: await blockTime(), keys });
    const proof = await (await proverSet.get("lp_set")).prove(set.inputs);
    const removeBefore = await spotSum("spot_remove");
    await waitJob(await submitRelay("setLiquidityRequest", relayBody(proof.proof, set.publicInputs)));
    await waitFor("a worker to execute the removal", async () => (await spotSum("spot_remove")) > removeBefore || null, 120_000);
    const m2 = model.get(2n)!;
    const out0 = (lp!.claim.shares * m2.r0) / m2.supply;
    const out1 = (lp!.claim.shares * m2.r1) / m2.supply;
    model.set(2n, { r0: m2.r0 - out0, r1: m2.r1 - out1, supply: m2.supply - lp!.claim.shares });
    await noteArrives(tokenA, out0);
    await noteArrives(tokenB, out1);

    const releasedBefore = await spotSum("locksReleased");
    const parked = await alice.placeLock(53n * USD, swapTerms(1n, 10n ** 24n, 0n), (await blockTime()) + 60n, { asset });
    await waitJob(parked.jobId);
    await waitSynced();
    await warp(3_800);
    await setPrice(100n);
    await waitFor("a worker to release the expired intent", async () => (await spotSum("locksReleased")) > releasedBefore || null, 120_000);
    await noteArrives(asset, 53n * USD);
    return { swap: swapOut, shares: added.shares, out0, out1, workerSwaps: await spotSum("spot_swap"), workerAdds: await spotSum("spot_add"), workerRemovals: await spotSum("spot_remove"), workerReleases: await spotSum("locksReleased") };
  });

  await step("spot restart: the coordinator comes back with no state, recovers pool state from ciphertexts and executes the next swap", async () => {
    stack.start("coordinator");
    await waitFor("coordinator healthy", async () => (await health("coordinator").catch(() => null))?.status === "ok", 60_000);
    await waitSynced();
    const { out } = await doSwap(1n, 0n, asset, tokenA, 25n * USD, 1n);
    await noteArrives(tokenA, out);
    assert((await counter("coordinator", "spot_swap")) >= 1, "a swap executed after restart");
    await stack.stop("risk-b", "SIGKILL");
    stack.start("risk-b");
    await waitFor("risk-b healthy", async () => (await health("risk-b").catch(() => null))?.status === "ok", 60_000);
    return { out, coordinatorSwapsAfterRestart: await counter("coordinator", "spot_swap") };
  });

  const poolInfo = async (id: bigint): Promise<PoolInfo> => {
    const p = (await c.client.readContract({ address: d.spot, abi, functionName: "pool", args: [id] })) as { token0: Address; token1: Address; feeBps: bigint; head: Hex };
    const events = await c.client.getContractEvents({ address: d.spot, abi, eventName: "PoolUpdated", args: { pool: id }, fromBlock: 0n });
    const last = events.at(-1);
    const state: PoolState = last ? openPoolState((last.args as unknown as { ciphertext: Hex[] }).ciphertext.map(BigInt).slice(0, 7), LOCAL_SCALARS.coordinator) : EMPTY_POOL;
    return { id, token0: BigInt(p.token0), token1: BigInt(p.token1), feeBps: p.feeBps, state, head: BigInt(p.head) };
  };
  const operatorProof = async (record: LockRecord): Promise<{ proof: Uint8Array; publicInputs: unknown }> => {
    await alice.refresh();
    const own = alice.wallet.ownLocks(alice.records).find((l) => l.record.recNonce === record.recNonce)!;
    const keys: readonly [{ x: bigint; y: bigint }, { x: bigint; y: bigint }, { x: bigint; y: bigint }] = [alice.coordinatorKey, ...(await readRiskKeys())];
    const w = swapWitness({ held: { record: own.record, leafIndex: own.leafIndex }, deployment: d.deploymentId, tree: alice.tree, pools: [await poolInfo(1n)], asOf: (await blockTime()) + 60n, keys });
    return { proof: (await (await proverSet.get("swap")).prove(w.inputs)).proof, publicInputs: w.publicInputs };
  };

  await step("spot head race: an operator lands an earlier intent ahead of the coordinator, and the coordinator re-proves on the new head", async () => {
    await waitSynced();
    await stack.stop("coordinator", "SIGKILL");
    await stack.stop("risk-a", "SIGKILL");
    await stack.stop("risk-b", "SIGKILL");
    // Inside the coordinator's minimum expiry margin, so it leaves these two to an operator and takes only the third.
    const viaRelayer = await doSwap(1n, 0n, asset, tokenA, 9n * USD, 1n, 280n);
    const frontRun = await doSwap(1n, 0n, asset, tokenA, 8n * USD, 1n, 280n);
    const third = await doSwap(1n, 0n, asset, tokenA, 7n * USD, 1n);
    await waitSynced();

    const relayed = await operatorProof(viaRelayer.leaf.record);
    await waitJob(await submitRelay("swap", relayBody(relayed.proof, relayed.publicInputs)));
    await noteArrives(tokenA, viaRelayer.out);
    await waitSynced();

    const ahead = await operatorProof(frontRun.leaf.record);
    serviceEnv.coordinator!.SPOT_MIN_EXPIRY_MARGIN_S = "300";
    await setAutomine(false);
    stack.start("coordinator");
    const selector = toFunctionSelector(getAbiItem({ abi, name: "swap" }) as Parameters<typeof toFunctionSelector>[0]);
    await waitInMempool(selector, d.spot, 1, "the coordinator's swap in the mempool");
    await c.wallet(stack.keys.deployer).writeContract({ address: d.spot, abi, functionName: "swap", args: [bytesToHex(ahead.proof), ahead.publicInputs], chain: foundry, gas: 12_000_000n, maxPriorityFeePerGas: 100_000_000_000n, maxFeePerGas: 400_000_000_000n });
    await waitInMempool(selector, d.spot, 2, "the operator's swap in the mempool");
    await mine(1);
    await setAutomine(true);
    await mine(1);
    await noteArrives(tokenA, frontRun.out);
    await waitFor("the coordinator to re-prove on the new head", async () => (await counter("coordinator", "reproved")) >= 1 || null, 90_000);
    await noteArrives(tokenA, third.out);
    delete serviceEnv.coordinator!.SPOT_MIN_EXPIRY_MARGIN_S;
    stack.start("risk-a");
    stack.start("risk-b");
    await waitFor("workers healthy", async () => (await health("risk-a").catch(() => null))?.status === "ok" && (await health("risk-b").catch(() => null))?.status === "ok" || null, 90_000);
    return { reproved: await counter("coordinator", "reproved"), relayedOut: viaRelayer.out, frontRunOut: frontRun.out, thirdOut: third.out };
  });

  await step("created market: picked up from MarketCreated, its bond covers a shortfall, and a worker returns the unused bond to the creator", async () => {
    const creator = privateKeyToAccount(stack.keys.deployer).address;
    const send = async (to: Address, callAbi: Abi, functionName: string, args: readonly unknown[]): Promise<void> => {
      const hash = await c.wallet(stack.keys.deployer).writeContract({ address: to, abi: callAbi, functionName, args, chain: foundry });
      const r = await c.client.waitForTransactionReceipt({ hash });
      assert(r.status === "success", `${functionName} reverted`);
    };
    const tokenAbi = parseAbi(["function mintTo(address,uint256)", "function approve(address,uint256) returns (bool)"]);
    const marketsAbi = (JSON.parse(readFileSync(`${FORGE_OUT}/PrivateMarkets.sol/PrivateMarkets.json`, "utf8")) as { abi: Abi }).abi;
    await send(asset, tokenAbi, "mintTo", [creator, 30n * USD]);
    await send(asset, tokenAbi, "approve", [d.markets, 30n * USD]);
    await setPrice(100n, d.thirdFeed);
    await send(d.markets, marketsAbi, "createMarket", [0n, d.thirdFeedId, 1_000_000n * WAD, 20n * USD]);
    const seen = await waitFor("read API to list market 100", async () => {
      const list = await getJson<{ markets: ({ market: string; bond: string } | null)[] }>(`${READ}/v1/markets`);
      return list.markets.find((m) => m?.market === "100") ?? null;
    }, 30_000);
    assert(seen.bond === (20n * USD).toString(), "the created market shows its bond", seen);

    const p = await openViaLock(100n, 12n * USD, WAD, 101n * WAD);
    await setPrice(70n, d.thirdFeed);
    await waitFor("liquidation in the created market", async () => (await alice.spent(p.pair.nullifier)) || null, 120_000);
    await waitFor("the shortfall folded", async () => (await marketView(100n)).oiPending === "0" || null, 120_000);
    const redeemedBefore = await spotSum("claimsRedeemed");
    await waitFor("the winner paid from the bond with no action", async () => (await spotSum("claimsRedeemed")) > redeemedBefore || null, 180_000);

    const balance = (): Promise<bigint> => c.client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [creator] });
    const before = await balance();
    await send(d.markets, marketsAbi, "closeToNewPositions", [100n]);
    await waitFor("a worker to release the bond", async () => (await spotSum("bondReleases")) >= 1 || null, 180_000);
    const returned = (await balance()) - before;
    const expectedClaim = 30_200_000n - 12n * USD;
    assert(returned === 20n * USD - expectedClaim, "only the unused bond returns to the creator", { returned, expectedClaim });
    return { bond: 20n * USD, used: expectedClaim, returned, bondReleases: await spotSum("bondReleases") };
  });

  await step("relayer rebroadcast: a transaction dropped from the mempool is resent and confirmed", async () => {
    await waitSynced();
    const before = await counter("relayer", "rebroadcasts");
    await setAutomine(false);
    const lock = await alice.placeLock(4n * USD, takerTerms(1n, false, WAD, 1n), (await blockTime()) + 20n * 86_400n);
    const job = await getJson<{ tx: Hex }>(`${RELAY}/v1/jobs/${lock.jobId}`);
    await rpc("anvil_dropTransaction", [job.tx]);
    await waitFor("relayer to rebroadcast", async () => (await counter("relayer", "rebroadcasts")) > before || null, 60_000);
    const content = await rpc<{ pending: Record<string, Record<string, { hash: string }>> }>("txpool_content");
    const repooled = Object.values(content.pending).some((byNonce) => Object.values(byNonce).some((t) => t.hash === job.tx));
    assert(repooled, "the original signed transaction is back in the mempool");
    await mine(1);
    await setAutomine(true);
    await mine(1);
    await waitJob(lock.jobId);
    return { rebroadcasts: await counter("relayer", "rebroadcasts") };
  });

  await step("a deep reorg rolls back the ledger, the tree, job status and all service views, and the chain continues", async () => {
    await waitSynced();
    await setPrice(100n);
    await waitFor("quiet maker", async () => Number((await health("maker")).backlog && ((await health("maker")).backlog as Record<string, number>).locksMissing === 0) === 1 || null, 120_000);
    await waitFor("funding fresh", async () => {
      const m = await marketView(1n);
      return (await blockTime()) - BigInt(m.funding.lastEpoch) < 3_000n || null;
    }, 180_000);
    await waitSynced();
    const snapshot = await rpc<string>("evm_snapshot");
    const baseline = await syncView();
    const head0 = BigInt(baseline.syncedBlock);
    const lock = await alice.placeLock(9n * USD, takerTerms(1n, false, WAD, 1n), (await blockTime()) + 20n * 86_400n);
    await waitJob(lock.jobId);
    const before = await waitSynced();
    assert(before.queueLength > baseline.queueLength, "the lock is on the read API before the reorg");
    const lockNf = recNullifier(lockCommitment(d.deploymentId, lock.record), lock.record.recNonce);
    const reorgsBefore = (await syncView()).reorgs;
    await mine(40);
    await waitFor("read API at the deep head", async () => BigInt((await syncView()).syncedBlock) >= head0 + 30n || null);
    const reverted = await rpc<boolean>("evm_revert", [snapshot]);
    assert(reverted === true, "evm_revert applied");
    await mine(3);
    const after = await waitFor("rollback", async () => {
      const s = await syncView();
      return s.reorgs > reorgsBefore && s.queueLength === baseline.queueLength && s.root === baseline.root ? s : null;
    }, 60_000);
    const spent = await alice.spent(lockNf);
    assert(!spent, "the rolled-back lock's nullifier is unspent again");
    const job = await waitJob(lock.jobId, "reorged", 60_000);
    assert(job.reasonCode === "REORGED", "relayer reports the reorg", job);
    const services: ServiceName[] = ["coordinator", "risk-a", "risk-b", "queue", "maker", "read-api", "relayer"];
    for (const name of services) await waitFor(`${name} to see the reorg`, async () => Number((await health(name)).reorgs) > 0 || null, 60_000);
    const repost = await submitRelay("lock", lock.body);
    await waitJob(repost);
    const again = await waitSynced();
    assert(again.queueLength > baseline.queueLength, "the same request lands on the new branch");
    return { blocksRolledBack: (await health("read-api")).deepestReorg, reorgs: after.reorgs, baselineRoot: baseline.root, jobAfterReorg: job.status };
  });

  await step("a reorg deeper than the retained checkpoints is answered by a full rebuild from the deployment block", async () => {
    await waitSynced();
    await stack.stop("read-api", "SIGTERM");
    serviceEnv["read-api"] = { CHECKPOINTS: "16" };
    stack.start("read-api");
    await waitFor("read API healthy", async () => (await health("read-api").catch(() => null))?.status === "ok", 60_000);
    await waitSynced();
    await setAutomine(false);
    const baseline = await syncView();
    const snapshot = await rpc<string>("evm_snapshot");
    for (let i = 0; i < 30; i++) {
      await mine(1);
      await sleep(350);
    }
    await waitFor("read API sees the long branch", async () => BigInt((await syncView()).syncedBlock) >= BigInt(baseline.syncedBlock) + 28n || null, 30_000);
    await rpc("evm_revert", [snapshot]);
    await setAutomine(true);
    await mine(2);
    const after = await waitFor("full rebuild", async () => {
      const h = await health("read-api");
      return Number(h.fullRebuilds) >= 1 ? h : null;
    }, 60_000);
    const s = await waitFor("rebuilt state", async () => {
      const v = await syncView();
      return v.root === baseline.root && v.queueLength >= baseline.queueLength ? v : null;
    }, 60_000);
    return { fullRebuilds: after.fullRebuilds, deepestReorg: after.deepestReorg, root: s.root };
  });

  await step("key rotation: services hold old and new keys across the change, an old position migrates forward and a new lock under the new keys is matched", async () => {
    await setPrice(100n);
    await waitFor("market 1 funding fresh", async () => {
      const m = await marketView(1n);
      return (await blockTime()) - BigInt(m.funding.lastEpoch) < 3_400n || null;
    }, 180_000);
    await waitFor("market 2 funding fresh", async () => {
      const m = await marketView(2n);
      return (await blockTime()) - BigInt(m.funding.lastEpoch) < 3_400n || null;
    }, 180_000);
    const old = await openViaLock(1n, 40n * USD, WAD, 110n * WAD);

    const scalars = { coordinator: 0xc00420n, riskA: 0xa2a2n, riskB: 0xb3b3n };
    const newKeys = { coordinator: mulGenerator(scalars.coordinator), riskA: mulGenerator(scalars.riskA), riskB: mulGenerator(scalars.riskB) };
    await Promise.all((["coordinator", "risk-a", "risk-b"] as ServiceName[]).map((n) => stack.stop(n, "SIGTERM")));
    serviceEnv.coordinator = { ...serviceEnv.coordinator, COORDINATOR_SK: scalars.coordinator.toString(), COORDINATOR_SK_PREVIOUS: LOCAL_SCALARS.coordinator.toString() };
    serviceEnv["risk-a"] = { ...serviceEnv["risk-a"], RISK_SK: scalars.riskA.toString(), RISK_SK_PREVIOUS: LOCAL_SCALARS.riskA.toString() };
    serviceEnv["risk-b"] = { ...serviceEnv["risk-b"], RISK_SK: scalars.riskB.toString(), RISK_SK_PREVIOUS: LOCAL_SCALARS.riskB.toString() };
    for (const n of ["coordinator", "risk-a", "risk-b"] as ServiceName[]) stack.start(n);
    for (const n of ["coordinator", "risk-a", "risk-b"] as ServiceName[]) {
      await waitFor(`${n} healthy holding both keys`, async () => {
        const h = await health(n).catch(() => null);
        const keys = h?.keys as { keysHeld?: number; currentKeyHeld?: boolean } | undefined;
        return h?.status === "ok" && keys?.keysHeld === 2 && keys?.currentKeyHeld === true ? h : null;
      }, 180_000);
    }

    const guardian = c.wallet(stack.keys.deployer);
    const schedule = await guardian.writeContract({ address: d.markets, abi, functionName: "scheduleKeyRotation", args: [{ coordinator: newKeys.coordinator, riskA: newKeys.riskA, riskB: newKeys.riskB }], chain: foundry });
    await c.client.waitForTransactionReceipt({ hash: schedule });
    await rpc("evm_increaseTime", [86_401]);
    await mine(1);
    await setPrice(100n);
    await setPrice(100n, otherFeed);
    const activate = await c.wallet(stack.keys.alice).writeContract({ address: d.markets, abi, functionName: "activateKeyRotation", chain: foundry });
    assert((await c.client.waitForTransactionReceipt({ hash: activate })).status === "success", "activation landed");
    const liveRisk = await readRiskKeys();
    assert(liveRisk[0].x === newKeys.riskA.x, "the contract now holds the new risk key");

    for (const n of ["risk-a", "risk-b", "coordinator"] as ServiceName[]) {
      await waitFor(`${n} to see the new key as current`, async () => {
        const h = await health(n);
        const keys = h.keys as { currentKeyHeld?: boolean; unreadableRecords?: number };
        return keys.currentKeyHeld === true && keys.unreadableRecords === 0 && String(h.blocked ?? "").indexOf("KEY_MISSING") === -1 ? h : null;
      }, 60_000);
    }
    await waitFor("the old position to migrate forward to the new keys", async () => {
      const a = await counter("risk-a", "keyMigrations");
      const b = await counter("risk-b", "keyMigrations");
      return a + b >= 1 || null;
    }, 180_000);
    await waitSynced();
    await waitFor("the migrated version to be in the tree", async () => {
      const v = await alice.pairFor(old.payout);
      return v && v.nullifier !== old.pair.nullifier ? v : null;
    }, 120_000);
    const migrated = (await alice.pairFor(old.payout))!;
    await alice.refresh();
    const migratedRecord = alice.records.find((r) => r.kind === RECORD_PAIR && r.leafIndex === migrated.leafIndex)!;
    const slot = (sk: bigint) => openPair(migratedRecord.ciphertext.slice(PAIR_CT_RISK_A * PAIR_CT_LEN, (PAIR_CT_RISK_A + 1) * PAIR_CT_LEN), sk, d.deploymentId, migratedRecord.commitment);
    assert(slot(scalars.riskA) !== null && slot(LOCAL_SCALARS.riskA) === null, "the migrated position is now on the new risk key only");
    assert(migrated.pair.size === old.pair.pair.size && migrated.pair.takerMargin + migrated.pair.makerMargin === old.pair.pair.takerMargin + old.pair.pair.makerMargin, "migration changed no value");

    alice.coordinatorKey = await readCoordinator();
    alice.riskKeys = await readRiskKeys();
    await setPrice(100n);
    const fresh = await openViaLock(1n, 45n * USD, WAD, 110n * WAD);
    const freshRecord = alice.records.find((r) => r.kind === RECORD_PAIR && r.leafIndex === fresh.pair.leafIndex)!;
    const freshSlot = (sk: bigint) => openPair(freshRecord.ciphertext.slice(PAIR_CT_RISK_A * PAIR_CT_LEN, (PAIR_CT_RISK_A + 1) * PAIR_CT_LEN), sk, d.deploymentId, freshRecord.commitment);
    assert(freshSlot(scalars.riskA) !== null && freshSlot(LOCAL_SCALARS.riskA) === null, "a position opened after rotation is on the new risk key only");
    const [a, b] = await Promise.all([health("risk-a"), health("risk-b")]);
    return { keyMigrations: (await counter("risk-a", "keyMigrations")) + (await counter("risk-b", "keyMigrations")), riskAKeys: a.keys, riskBKeys: b.keys };
  });

  await step("oracle end states: an exit settles at entry on a dead oracle, the epoch keeps ticking with no accrual, and a dead market sweeps its insurance", async () => {
    const m2Ready = async (): Promise<void> => {
      await setPrice(100n, otherFeed);
      await setPrice(100n);
    };
    await m2Ready();
    await waitFor("market 2 funding fresh", async () => {
      const m = await marketView(2n);
      return (await blockTime()) - BigInt(m.funding.lastEpoch) < 3_400n || null;
    }, 180_000);
    const insured = await openViaLock(2n, 50n * USD, WAD, 110n * WAD);
    await setPrice(52n, otherFeed);
    await waitFor("market 2 liquidation for insurance", async () => (await alice.spent(insured.pair.nullifier)) || null, 120_000);
    await waitFor("folded", async () => (await marketView(2n)).oiPending === "0" || null, 120_000);
    await m2Ready();
    await waitFor("market 2 funding fresh again", async () => {
      const m = await marketView(2n);
      return (await blockTime()) - BigInt(m.funding.lastEpoch) < 3_400n || null;
    }, 120_000);
    const p = await openViaLock(2n, 40n * USD, WAD, 110n * WAD);
    const w = exitRequestWitness({ pair: p.pair.pair, leafIndex: p.pair.leafIndex, deployment: d.deploymentId, tree: alice.tree, sk: p.payout.sk });
    const proof = await (await proverSet.get("exit_request")).prove(w.inputs);
    await waitJob(await submitRelay("requestExit", relayBody(proof.proof, { root: w.root, nullifier: w.nullifier })));
    await waitFor("exit recorded", async () => {
      const r = await getJson<{ exits: ({ matureAt: string } | null)[] }>(`${READ}/v1/exits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nullifiers: [w.nullifier] }) });
      return r.exits[0] ?? null;
    });
    const forcedBefore = (await counter("risk-a", "forcedCloses")) + (await counter("risk-b", "forcedCloses"));
    await warp(15 * 86_400);
    await waitFor("dead-oracle close", async () => (await alice.spent(p.pair.nullifier)) || null, 240_000);
    await waitFor("close counted", async () => ((await counter("risk-a", "forcedCloses")) + (await counter("risk-b", "forcedCloses"))) > forcedBefore || null, 30_000);
    const epochs = await waitFor("a stale-oracle epoch with no accrual", async () => {
      const f = await getJson<{ items: { dt: string; mark: string; index: string }[] }>(`${READ}/v1/markets/2/funding?limit=512`);
      const stale = f.items.map((e, i) => ({ e, prev: f.items[i - 1] })).filter(({ e, prev }) => e.dt === "0" && e.mark === "0" && prev !== undefined);
      return stale.length > 0 ? stale : null;
    }, 180_000);
    assert(epochs.every(({ e, prev }) => e.index === prev!.index), "the index does not move on a stale oracle epoch", epochs.map((x) => x.e.index));
    await waitFor("close folded", async () => (await marketView(2n)).oiPending === "0" || null, 240_000);
    await waitSynced();
    await alice.refresh();
    const feeWallet = new ShieldedWallet(LOCAL_SCALARS.fee, d.deploymentId);
    const feeBefore = feeWallet.notes(alice.records, alice.deposits, alice.processed, () => false).reduce((a, n) => a + n.value, 0n);
    await warp(91 * 86_400);
    const swept = await waitFor("insurance sweep", async () => {
      const n = (await counter("risk-a", "insuranceSweeps")) + (await counter("risk-b", "insuranceSweeps"));
      return n >= 1 ? n : null;
    }, 240_000);
    await waitSynced();
    await alice.refresh();
    const feeAfter = feeWallet.notes(alice.records, alice.deposits, alice.processed, () => false).reduce((a, n) => a + n.value, 0n);
    assert(feeAfter > feeBefore, "the fee address gained the swept insurance as a shielded note", { feeBefore, feeAfter });
    return { staleEpochs: epochs.length, swept, insurance: feeAfter - feeBefore };
  });

  await step("malformed requests are refused with named reasons", async () => {
    const post = (path: string, body: string, headers: Record<string, string> = { "content-type": "application/json" }): Promise<Response> => fetch(`${RELAY}${path}`, { method: "POST", headers, body });
    const reason = async (res: Response): Promise<string> => ((await res.json()) as { reasonCode: string }).reasonCode;
    const checks: Record<string, { status: number; reason: string }> = {};
    const check = async (label: string, res: Response, status: number, want: string): Promise<void> => {
      const got = await reason(res);
      assert(res.status === status && got === want, `${label}: expected ${status} ${want}, got ${res.status} ${got}`);
      checks[label] = { status: res.status, reason: got };
    };
    await check("not JSON", await post("/v1/relay/lock", "not json"), 400, "INVALID_JSON");
    await check("unknown action", await post("/v1/relay/transfer", JSON.stringify({ proof: "0x01", publicInputs: {} })), 404, "UNKNOWN_ACTION");
    await check("missing proof", await post("/v1/relay/lock", JSON.stringify({ publicInputs: {} })), 400, "INVALID_REQUEST");
    await check("wrong field set", await post("/v1/relay/lock", JSON.stringify({ proof: "0x01ab", publicInputs: { root: toHex32(1n) } })), 400, "INVALID_REQUEST");
    await check("body too large", await post("/v1/relay/lock", "x".repeat(300_000)), 413, "BODY_TOO_LARGE");
    await check("unknown job", await fetch(`${RELAY}/v1/jobs/0x${"ab".repeat(32)}`), 404, "JOB_UNKNOWN");
    await check("bad job id", await fetch(`${RELAY}/v1/jobs/nope`), 400, "INVALID_REQUEST");
    await check("wrong method", await fetch(`${RELAY}/v1/relay/lock`), 405, "METHOD_NOT_ALLOWED");
    await check("read: bad limit", await fetch(`${READ}/v1/records?limit=99999`), 400, "INVALID_REQUEST");
    await check("quote: bad pool", await fetch(`${READ}/v1/spot/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: "abc", assetIn: asset, amountIn: "1" }) }), 400, "INVALID_REQUEST");
    await check("quote: unknown pool", await fetch(`${READ}/v1/spot/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: "99", assetIn: asset, amountIn: "1000000" }) }), 422, "UNKNOWN_POOL");
    await check("relay: swap bad shape", await post("/v1/relay/swap", JSON.stringify({ proof: "0x01ab", publicInputs: { root: toHex32(1n) } })), 400, "INVALID_REQUEST");
    await check("read: bad path index", await fetch(`${READ}/v1/tree/path/abc`), 400, "INVALID_REQUEST");
    await check("read: nullifier list too big", await fetch(`${READ}/v1/nullifiers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nullifiers: Array.from({ length: 300 }, () => toHex32(1n)) }) }), 400, "INVALID_REQUEST");
    // A well-formed request with a bad proof is refused by simulation, costing the relayer nothing.
    await alice.refresh();
    const n = (await alice.notes()).find((x) => x.asset === BigInt(asset))!;
    const w = lockWitness({ keys: n.keys, deployment: d.deploymentId, tree: alice.tree, asset: BigInt(asset), inputs: [n], amount: USD, terms: takerTerms(1n, false, WAD, 200n * WAD), expiry: (await blockTime()) + 86_400n, coordinator: alice.coordinatorKey, riskKeys: alice.riskKeys, payout: addressOf(lockAddressKeys(ALICE_SEED, 900)), view: alice.main.pk });
    const forged = await post("/v1/relay/lock", relayBody(new Uint8Array(4096).fill(7), w.publicInputs));
    const forgedReason = await reason(forged);
    assert(forged.status === 422 && forgedReason === "INVALID_PROOF", "a forged proof is refused by simulation with a named reason", { status: forged.status, forgedReason });
    checks["forged proof"] = { status: forged.status, reason: forgedReason };
    return checks;
  });

  await step("logs carry no keys, seeds or decrypted values", async () => {
    const haystack = readdirSync(LOG_DIR).filter((f) => f !== "anvil.log").map((f) => readFileSync(`${LOG_DIR}/${f}`, "utf8")).join("\n");
    const toFind: Record<string, string> = {
      coordinatorSk: LOCAL_SCALARS.coordinator.toString(16),
      riskA: `"${LOCAL_SCALARS.riskA.toString()}"`,
      riskB: `"${LOCAL_SCALARS.riskB.toString()}"`,
      newRiskA: `"${(0xa2a2n).toString()}"`,
      newCoordinator: (0xc00420n).toString(16),
      makerSeed: LOCAL_SCALARS.maker.toString(16),
      aliceSeed: ALICE_SEED.toString(16),
      deployerKey: stack.keys.deployer.slice(2),
      relayerKey: stack.keys.relayerTx.slice(2),
      aliceOneTimeX: p1!.payout.pk.x.toString(),
      aliceOneTimeHex: toHex32(p1!.payout.pk.x).slice(2),
      positionNonce: p1!.pair.pair.recNonce.toString(16),
    };
    const found = Object.entries(toFind).filter(([, v]) => haystack.includes(v)).map(([k]) => k);
    assert(found.length === 0, "secret or decrypted value found in service logs", found);
    return { bytesScanned: haystack.length, checked: Object.keys(toFind) };
  });

  await step("final health: every service reports honest liveness with block, last action and backlog", async () => {
    const out: Record<string, unknown> = {};
    for (const name of ["read-api", "relayer", "queue", "coordinator", "risk-a", "risk-b", "maker"] as ServiceName[]) {
      const h = await waitFor(`${name} healthy`, async () => {
        const body = await health(name);
        return body.status === "ok" ? body : null;
      }, 30_000);
      assert(h.lastBlockSeen !== null && typeof h.backlog === "object", `${name} reports liveness`, h);
      out[name] = { lastBlockSeen: h.lastBlockSeen, lastAction: h.lastAction, backlog: h.backlog, counters: h.counters };
    }
    return out;
  });
}

async function readCoordinator(): Promise<{ x: bigint; y: bigint }> {
  const [x, y] = await Promise.all([c.client.readContract({ address: pool, abi, functionName: "coordinatorX" }), c.client.readContract({ address: pool, abi, functionName: "coordinatorY" })]);
  return { x: x as bigint, y: y as bigint };
}
async function readRiskKeys(): Promise<readonly [{ x: bigint; y: bigint }, { x: bigint; y: bigint }]> {
  const [ax, ay, bx, by] = (await Promise.all(["riskAX", "riskAY", "riskBX", "riskBY"].map((functionName) => c.client.readContract({ address: pool, abi, functionName })))) as [bigint, bigint, bigint, bigint];
  return [{ x: ax, y: ay }, { x: bx, y: by }];
}
async function readFeeTo(): Promise<{ auth: bigint; pk: { x: bigint; y: bigint } }> {
  const [auth, x, y] = (await Promise.all(["feeAuth", "feeX", "feeY"].map((functionName) => c.client.readContract({ address: pool, abi, functionName })))) as [bigint, bigint, bigint];
  return { auth, pk: { x, y } };
}

// Checked before the evidence file can be touched: a run that never started must not overwrite real results.
if (await isListening(LOCAL_RPC_PORT)) {
  console.error(`port ${LOCAL_RPC_PORT} is in use; another run is active. No evidence written.`);
  process.exit(2);
}

const startedAt = new Date().toISOString();
let passed = false;
try {
  await main();
  passed = true;
} catch (error) {
  console.error("integration run failed:", error instanceof Error ? error.message : error);
} finally {
  await proverRef.current?.destroyAll().catch((error: unknown) => console.warn(`prover shutdown: ${String(error)}`));
  await stack.stopAll();
  writeJson(EVIDENCE, {
    note: "Local anvil (31337) on the test's own ports. Services as separate OS processes, real UltraHonk proofs, anvil's public keys and synthetic seeds.",
    startedAt, finishedAt: new Date().toISOString(), passed, logDir: LOG_DIR, steps,
  });
  console.log(passed ? `${steps.length} steps passed` : "FAILED; see evidence and logs");
  process.exit(passed ? 0 : 1);
}

