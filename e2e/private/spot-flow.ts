/**
 * Private spot end to end: seed pools, swap, routed swap, operator attacks, expiry refunds, private LP add and remove, restore from
 * seed, and custody per token. Real UltraHonk proofs, verified by the generated Solidity verifiers on a dedicated anvil.
 *
 *   anvil --port 8549 --code-size-limit 100000 --gas-limit 1000000000 &
 *   RPC=http://127.0.0.1:8549 bun run private/spot-flow.ts
 *
 * Writes docs/privacy/evidence/spot-flow-local.json. Anvil's public test keys and synthetic seeds only.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  addressOf, amountOut, APPEND_BATCH, appendWitness, depositOpening, deriveKeys, EMPTY_POOL, initCrypto, leafOf, lockAddressKeys, LOCK_CT_LEN, lockCommitment, lockWitness,
  LP_CT_LEN, lpAddWitness, lpRemoveWitness, lpSetWitness, lpTerms, MerkleTree, mulGenerator, noteInner, openLock, openLp, openPoolState, poolHead, Prover, RECORD_FREE, RECORD_LOCK, RECORD_LP, recNullifier, releaseWitness, scanCreated, scanDeposits,
  swapTerms, swapWitness, toHex32,
  type CompiledCircuit, type CreatedNotes, type HeldLock, type LockTerms, type LpRecord, type OwnedNote, type PoolInfo, type PoolState, type QueueEntry, type ShieldedDeposit, type WalletKeys,
} from "@rooq/private-sdk";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RPC = process.env.RPC ?? "http://127.0.0.1:8549";
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  alice: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  bob: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  operator: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  stranger: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const;
const ALICE_SEED = 0xa11ce5eedn;
const BOB_SEED = 0xb0b5eedn;
const COORDINATOR_SK = 0xc0041n;
const USD = 1_000_000n;
const WAD = 10n ** 18n;
const ADDRESS_GAP = 30;
const FEE = 30n;

const read = (p: string): string => readFileSync(`${ROOT}${p}`, "utf8");
const artifact = (n: string): Abi => (JSON.parse(read(`contracts/out/${n}.sol/${n}.json`)) as { abi: Abi }).abi;
const circuit = (n: string): CompiledCircuit => JSON.parse(read(`zk/circuits/target/${n}.json`)) as CompiledCircuit;
const poolAbi = artifact("PrivatePairs");
const spotAbi = artifact("PrivateSpot");
const erc20 = parseAbi(["function mintTo(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

const steps: { step: string; ok: boolean; detail: unknown }[] = [];
const gas: Record<string, string> = {};
const proveMs: Record<string, number> = {};
const stringify = (x: unknown): string => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
function record(step: string, ok: boolean, detail: unknown = {}): void {
  steps.push({ step, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${step}`);
  if (!ok) throw new Error(`${step}: ${stringify(detail)}`);
}

const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: foundry, transport: http(RPC) });
const toHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;

async function send(k: Hex, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
  const hash = await wallet(k).writeContract({ address, abi, functionName, args, chain: foundry });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  gas[functionName] = r.gasUsed.toString();
  return r;
}

const PROOF_FAILURES = new Set(["0x9fc3a218", "0xa5d82e8a", "0xa2a2ac83", "0xeb73e0bd", "0x20a33589", "0x607be13e", "0x4ddaa5e5"]);
async function reverts(k: Hex, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<string | null> {
  try {
    await pub.simulateContract({ account: privateKeyToAccount(k), address, abi, functionName, args });
    return null;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    const named = /Error: (\w+\(.*?\))/.exec(m)?.[1];
    if (named) return named;
    const sig = /following signature:\s*\n?\s*(0x[0-9a-f]{8})/i.exec(m)?.[1]?.toLowerCase();
    if (sig) return PROOF_FAILURES.has(sig) ? `verifier:${sig}` : sig;
    return m.slice(0, 900);
  }
}
const verifierRejected = (r: string | null): boolean => r?.startsWith("verifier:") ?? false;

async function refuses(prover: Prover, inputs: Parameters<Prover["prove"]>[0], constraint: string): Promise<{ ok: boolean; message: string }> {
  try {
    await prover.prove(inputs);
    return { ok: false, message: "proof generated" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: message.includes(constraint), message };
  }
}

async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  proveMs[name] = Math.round(performance.now() - t0);
  return r;
}

interface Deployment { pool: Address; spot: Address; usd: Address; tokenA: Address; tokenB: Address; deploymentId: bigint }

function deploy(out: string, keys: readonly [{ x: bigint; y: bigint }, { x: bigint; y: bigint }, { x: bigint; y: bigint }], feeTo: WalletKeys): Deployment {
  execFileSync("forge", ["script", "script/DeployPrivatePairs.s.sol", "--rpc-url", RPC, "--broadcast", "--slow", "--silent"], {
    cwd: `${ROOT}contracts`,
    env: {
      ...process.env, DEPLOYER_PRIVATE_KEY: KEYS.deployer, PRIVACY_OUT: out,
      COORDINATOR_X: keys[0].x.toString(), COORDINATOR_Y: keys[0].y.toString(), RISK_A_X: keys[1].x.toString(), RISK_A_Y: keys[1].y.toString(), RISK_B_X: keys[2].x.toString(), RISK_B_Y: keys[2].y.toString(),
      FEE_AUTH: feeTo.auth.toString(), FEE_X: feeTo.pk.x.toString(), FEE_Y: feeTo.pk.y.toString(),
    },
    stdio: "pipe",
  });
  const d = JSON.parse(readFileSync(out, "utf8")) as { pool: Address; spot: Address; asset: Address; spotTokens: Address[]; deploymentId: number | string };
  return { pool: d.pool, spot: d.spot, usd: d.asset, tokenA: d.spotTokens[0]!, tokenB: d.spotTokens[1]!, deploymentId: BigInt(d.deploymentId) };
}

const readPool = <T>(d: Deployment, functionName: string, args: readonly unknown[] = []): Promise<T> => pub.readContract({ address: d.pool, abi: poolAbi, functionName, args }) as Promise<T>;
const blockTime = async (): Promise<bigint> => (await pub.getBlock()).timestamp;
const warp = async (seconds: number): Promise<void> => {
  await pub.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
  await pub.request({ method: "evm_mine" as never, params: [] as never });
};

async function queue(d: Deployment, from: bigint, to: bigint): Promise<QueueEntry[]> {
  const out: QueueEntry[] = [];
  for (let i = from; i < to; i++) {
    const e = await readPool<{ kind: number; a: Hex; b: Hex; c: Hex }>(d, "queueEntry", [i]);
    out.push({ kind: BigInt(e.kind), a: BigInt(e.a), b: BigInt(e.b), c: BigInt(e.c) });
  }
  return out;
}

async function chainTree(d: Deployment): Promise<MerkleTree> {
  const tree = new MerkleTree();
  for (const e of await queue(d, 0n, await readPool<bigint>(d, "processed"))) tree.insert(leafOf(e, d.deploymentId));
  return tree;
}

interface ChainRecord { leafIndex: number; kind: number; commitment: bigint; ciphertext: bigint[] }
async function chainRecords(d: Deployment): Promise<ChainRecord[]> {
  const all = await pub.getContractEvents({ address: d.pool, abi: poolAbi, eventName: "RecordCreated", fromBlock: 0n });
  return all.map((l) => {
    const a = l.args as { leafIndex: bigint; kind: number; commitment: Hex; ciphertext: Hex[] };
    return { leafIndex: Number(a.leafIndex), kind: Number(a.kind), commitment: BigInt(a.commitment), ciphertext: a.ciphertext.map(BigInt) };
  });
}

async function chainDeposits(d: Deployment): Promise<ShieldedDeposit[]> {
  const all = await pub.getContractEvents({ address: d.pool, abi: poolAbi, eventName: "Shielded", fromBlock: 0n });
  return all.map((l) => {
    const a = l.args as { leafIndex: bigint; asset: Address; amount: bigint; inner: Hex };
    return { leafIndex: Number(a.leafIndex), asset: BigInt(a.asset), amount: a.amount, inner: BigInt(a.inner) };
  });
}

type Note = OwnedNote & { keys: WalletKeys };

async function usedAddresses(seed: bigint, d: Deployment): Promise<WalletKeys[]> {
  const main = deriveKeys(seed);
  const payouts = new Set<bigint>();
  for (const r of await chainRecords(d)) {
    if (r.kind !== RECORD_LOCK) continue;
    const l = openLock(r.ciphertext.slice(0, LOCK_CT_LEN), main.encSk, d.deploymentId, r.commitment);
    if (l) payouts.add(l.ownerX);
  }
  const found: WalletKeys[] = [];
  for (let i = 0, misses = 0; misses < ADDRESS_GAP; i++) {
    const k = lockAddressKeys(seed, i);
    if (payouts.has(k.pk.x)) {
      found.push(k);
      misses = 0;
    } else {
      misses++;
    }
  }
  return found;
}

/** Spendable notes rebuilt from a seed and public chain data alone. */
async function restore(seed: bigint, d: Deployment): Promise<Note[]> {
  const main = deriveKeys(seed);
  const created: CreatedNotes[] = (await chainRecords(d)).filter((r) => r.kind === RECORD_FREE).map((r) => ({ firstLeafIndex: r.leafIndex, commitments: [r.commitment], ciphertexts: [r.ciphertext] }));
  const processed = Number(await readPool<bigint>(d, "processed"));
  const mine: Note[] = scanDeposits(seed, main, d.deploymentId, await chainDeposits(d)).map((n) => ({ ...n, keys: main }));
  for (const keys of [main, ...(await usedAddresses(seed, d))]) mine.push(...scanCreated(keys, d.deploymentId, created).map((n) => ({ ...n, keys })));
  const live: Note[] = [];
  for (const n of mine) {
    if (n.value > 0n && n.leafIndex < processed && !(await readPool<boolean>(d, "nullifierSpent", [toHex32(n.nullifier)]))) live.push(n);
  }
  return live.sort((a, b) => a.leafIndex - b.leafIndex);
}

async function main(): Promise<void> {
  await initCrypto();
  record("dedicated local chain", (await pub.getChainId()) === 31337);
  const keys = [mulGenerator(COORDINATOR_SK), mulGenerator(0xa1a1n), mulGenerator(0xb2b2n)] as const;
  const d = deploy(`${ROOT}contracts/deployments/privacy-e2e-spot.json`, keys, deriveKeys(0xfee5eedn));
  record("deploy custody and spot sharing one tree", (await readPool<Address>(d, "spotModule")).toLowerCase() === d.spot.toLowerCase(), { spot: d.spot });

  const load = (c: string): Promise<Prover> => Prover.create(circuit(c));
  const [appendP, lockP, swapP, addP, setP, removeP, releaseP] = await Promise.all([load("append"), load("lock"), load("swap"), load("lp_add"), load("lp_set"), load("lp_remove"), load("release")]);
  try {
    const alice = deriveKeys(ALICE_SEED);
    const bob = deriveKeys(BOB_SEED);
    const [aliceEoa, bobEoa] = [privateKeyToAccount(KEYS.alice).address, privateKeyToAccount(KEYS.bob).address];
    const processQueue = async (): Promise<void> => {
      for (;;) {
        const [len, done] = await Promise.all([readPool<bigint>(d, "queueLength"), readPool<bigint>(d, "processed")]);
        if (done >= len) return;
        const end = done + BigInt(Math.min(APPEND_BATCH, Number(len - done)));
        const { inputs, newRoot } = appendWitness(await chainTree(d), await queue(d, done, end), d.deploymentId);
        await send(KEYS.stranger, d.pool, poolAbi, "processQueue", [toHex((await appendP.prove(inputs)).proof), toHex32(newRoot)]);
      }
    };
    const depositIndex: Record<string, number> = { alice: 0, bob: 0 };
    const shield = async (who: "alice" | "bob", asset: Address, amount: bigint): Promise<void> => {
      const [k, eoa, seed, w] = who === "alice" ? [KEYS.alice, aliceEoa, ALICE_SEED, alice] as const : [KEYS.bob, bobEoa, BOB_SEED, bob] as const;
      await send(KEYS.deployer, asset, erc20 as Abi, "mintTo", [eoa, amount]);
      await send(k, asset, erc20 as Abi, "approve", [d.pool, amount]);
      const { rho, blind } = depositOpening(seed, depositIndex[who]!++);
      await send(k, d.pool, poolAbi, "shield", [asset, amount, toHex32(noteInner(w.owner, rho, blind))]);
    };
    await shield("alice", d.usd, 10_000n * USD);
    await shield("alice", d.tokenA, 1_000n * WAD);
    await shield("alice", d.tokenA, 1_000n * WAD);
    await shield("alice", d.tokenB, 2_000n * WAD);
    await shield("bob", d.usd, 100n * USD);
    await shield("bob", d.usd, 200n * USD);
    await shield("bob", d.usd, 50n * USD);
    await processQueue();
    record("both wallets shield several assets; queue processed by a stranger", (await restore(ALICE_SEED, d)).length === 4 && (await restore(BOB_SEED, d)).length === 3);

    const nextAddress = { alice: 0, bob: 0 };
    const lockNote = async (who: "alice" | "bob", note: Note, terms: LockTerms, expiry: bigint, sameAddressAsLast = false): Promise<void> => {
      const seed = who === "alice" ? ALICE_SEED : BOB_SEED;
      const view = (who === "alice" ? alice : bob).pk;
      const w = lockWitness({
        keys: note.keys, deployment: d.deploymentId, tree: await chainTree(d), asset: note.asset, inputs: [note], amount: note.value, terms, expiry, coordinator: keys[0], riskKeys: [keys[1], keys[2]],
        payout: addressOf(lockAddressKeys(seed, sameAddressAsLast ? nextAddress[who] - 1 : nextAddress[who]++)), view,
      });
      await send(KEYS.stranger, d.pool, poolAbi, "lock", [toHex((await lockP.prove(w.inputs)).proof), { ...w.publicInputs }]);
    };
    const operatorLocks = async (): Promise<HeldLock[]> => {
      const out: HeldLock[] = [];
      for (const r of await chainRecords(d)) {
        if (r.kind !== RECORD_LOCK) continue;
        const rec = openLock(r.ciphertext.slice(LOCK_CT_LEN, 2 * LOCK_CT_LEN), COORDINATOR_SK, d.deploymentId, r.commitment);
        if (!rec) continue;
        const nf = recNullifier(lockCommitment(d.deploymentId, rec), rec.recNonce);
        if (!(await readPool<boolean>(d, "nullifierSpent", [toHex32(nf)]))) out.push({ record: rec, leafIndex: r.leafIndex });
      }
      return out;
    };
    const findLock = async (role: bigint, amount: bigint): Promise<HeldLock> => {
      const h = (await operatorLocks()).find((x) => x.record.role === role && x.record.amount === amount);
      if (!h) throw new Error(`lock ${role} ${amount} not found`);
      return h;
    };
    const poolInfo = async (id: bigint): Promise<PoolInfo> => {
      const p = (await pub.readContract({ address: d.spot, abi: spotAbi, functionName: "pool", args: [id] })) as { token0: Address; token1: Address; feeBps: bigint; head: Hex };
      const events = await pub.getContractEvents({ address: d.spot, abi: spotAbi, eventName: "PoolUpdated", args: { pool: id }, fromBlock: 0n });
      const last = events.at(-1);
      const state: PoolState = last ? openPoolState((last.args as { ciphertext: Hex[] }).ciphertext.map(BigInt).slice(0, 7), COORDINATOR_SK) : EMPTY_POOL;
      return { id, token0: BigInt(p.token0), token1: BigInt(p.token1), feeBps: p.feeBps, state, head: BigInt(p.head) };
    };
    const asOf = async (): Promise<bigint> => (await blockTime()) + 600n;
    const noteOf = async (seed: bigint, asset: Address, value: bigint): Promise<Note> => {
      const n = (await restore(seed, d)).find((x) => x.asset === BigInt(asset) && x.value === value);
      if (!n) throw new Error(`note ${value} not found`);
      return n;
    };
    const execSwap = (w: ReturnType<typeof swapWitness>, proof: Uint8Array) => [toHex(proof), { ...w.publicInputs }] as const;

    // Seed both pools from LP locks.
    const seed = async (pool: bigint, token0: Address, amount0: bigint, token1: Address, amount1: bigint): Promise<LpRecord> => {
      const expiry = (await blockTime()) + 3600n;
      await lockNote("alice", await noteOf(ALICE_SEED, token0, amount0), lpTerms(pool, 0n, 1n, 1000n + pool), expiry);
      await lockNote("alice", await noteOf(ALICE_SEED, token1, amount1), lpTerms(pool, 1n, 1n, 1000n + pool), expiry, true);
      await processQueue();
      const w = lpAddWitness({ lock0: await findLock(4n, amount0), lock1: await findLock(4n, amount1), pool: await poolInfo(pool), deployment: d.deploymentId, tree: await chainTree(d), asOf: await asOf(), keys });
      const p = await timed("lp_add", () => addP.prove(w.inputs));
      await send(KEYS.operator, d.spot, spotAbi, "addLiquidity", [toHex(p.proof), { ...w.publicInputs }]);
      await processQueue();
      return w.record;
    };
    const lp1 = await seed(1n, d.usd, 10_000n * USD, d.tokenA, 1_000n * WAD);
    await seed(2n, d.tokenA, 1_000n * WAD, d.tokenB, 2_000n * WAD);
    const seeded = await poolInfo(1n);
    record("first deposit seeds the pool and burns the minimum liquidity", seeded.state.r0 === 10_000n * USD && seeded.state.r1 === 1_000n * WAD && lp1.shares === seeded.state.supply - 1000n, { shares: lp1.shares });
    record("the pool's reserves are private: the contract stores only a commitment", seeded.head === poolHead(d.deploymentId, 1n, seeded.state));

    // A swap with no public transfer.
    const expiry = async (): Promise<bigint> => (await blockTime()) + 3600n;
    const quote = amountOut(100n * USD, seeded.state.r0, seeded.state.r1, FEE);
    await lockNote("bob", await noteOf(BOB_SEED, d.usd, 100n * USD), swapTerms(1n, quote), await expiry());
    await lockNote("bob", await noteOf(BOB_SEED, d.usd, 200n * USD), swapTerms(1n, 1n, 2n), await expiry());
    await processQueue();
    const swap1 = await findLock(3n, 100n * USD);
    const swap2 = await findLock(3n, 200n * USD);

    const tooGreedy = { ...swap1, record: { ...swap1.record, t3: quote + 1n } };
    const greedyRefused = await refuses(swapP, swapWitness({ held: tooGreedy, deployment: d.deploymentId, tree: await chainTree(d), pools: [seeded], asOf: await asOf(), keys }).inputs, "intent not in tree");
    record("the operator cannot change a trader's limits", greedyRefused.ok, greedyRefused);

    const thin = await poolInfo(1n);
    const movedAgainst = { ...thin, state: { ...thin.state, r1: thin.state.r1 / 2n }, head: poolHead(d.deploymentId, 1n, { ...thin.state, r1: thin.state.r1 / 2n }) };
    const slipped = await refuses(swapP, swapWitness({ held: swap1, deployment: d.deploymentId, tree: await chainTree(d), pools: [movedAgainst], asOf: await asOf(), keys }).inputs, "below minimum output");
    record("a fill below the trader's minimum cannot be proven", slipped.ok, slipped);

    const w1 = swapWitness({ held: swap1, deployment: d.deploymentId, tree: await chainTree(d), pools: [await poolInfo(1n)], asOf: await asOf(), keys });
    record("the swap output matches the pool formula", w1.out === quote, { out: w1.out });
    const p1 = await timed("swap", () => swapP.prove(w1.inputs));
    const redirected = await reverts(KEYS.operator, d.spot, spotAbi, "swap", [toHex(p1.proof), { ...w1.publicInputs, outCommitment: toHex32(BigInt(w1.publicInputs.outCommitment) + 1n) }]);
    record("redirecting the output is rejected by the verifier", verifierRejected(redirected), { redirected });

    // The later intent runs first, so the earlier one can no longer run.
    const routed = swapWitness({ held: swap2, deployment: d.deploymentId, tree: await chainTree(d), pools: [await poolInfo(1n), await poolInfo(2n)], asOf: await asOf(), keys });
    const routedTx = await send(KEYS.operator, d.spot, spotAbi, "swap", execSwap(routed, (await timed("swap_routed", () => swapP.prove(routed.inputs))).proof));
    await processQueue();
    record("a two-hop swap settles atomically with no public token transfer", routedTx.logs.filter((l) => [d.usd, d.tokenA, d.tokenB].some((t) => t.toLowerCase() === l.address.toLowerCase())).length === 0 && routed.next.length === 2, { out: routed.out });
    record("the routed output reaches the trader as a shielded note in the final token", (await restore(BOB_SEED, d)).some((n) => n.asset === BigInt(d.tokenB) && n.value === routed.out));

    const stale = await reverts(KEYS.operator, d.spot, spotAbi, "swap", execSwap(w1, p1.proof));
    record("a proof against an old pool state is rejected by the verifier", verifierRejected(stale), { stale });
    const lateOrder = await refuses(swapP, swapWitness({ held: swap1, deployment: d.deploymentId, tree: await chainTree(d), pools: [await poolInfo(1n)], asOf: await asOf(), keys }).inputs, "intent out of order");
    record("an earlier intent cannot run after a later one, so the operator cannot reorder trades", lateOrder.ok, lateOrder);

    // That skipped intent refunds at expiry, from the trader's own copy.
    await warp(3700);
    const expired = await refuses(swapP, swapWitness({ held: swap1, deployment: d.deploymentId, tree: await chainTree(d), pools: [await poolInfo(1n)], asOf: await asOf(), keys }).inputs, "intent expired");
    record("an expired intent cannot be executed", expired.ok, expired);
    const bobOwn = (await chainRecords(d)).filter((r) => r.kind === RECORD_LOCK).map((r) => ({ leafIndex: r.leafIndex, record: openLock(r.ciphertext.slice(0, LOCK_CT_LEN), bob.encSk, d.deploymentId, r.commitment) })).find((h) => h.record?.amount === 100n * USD);
    const rel = releaseWitness({ held: { record: bobOwn!.record!, leafIndex: bobOwn!.leafIndex }, deployment: d.deploymentId, tree: await chainTree(d), asOf: await blockTime() });
    await send(KEYS.stranger, d.pool, poolAbi, "release", [toHex((await releaseP.prove(rel.inputs)).proof), { ...rel.publicInputs }]);
    await processQueue();
    record("a skipped swap comes back to the trader without the operator", (await restore(BOB_SEED, d)).some((n) => n.asset === BigInt(d.usd) && n.value === 100n * USD));

    // A plain swap in order, then liquidity removal.
    const before = await poolInfo(1n);
    const direct = amountOut(50n * USD, before.state.r0, before.state.r1, FEE);
    await lockNote("bob", await noteOf(BOB_SEED, d.usd, 50n * USD), swapTerms(1n, direct), await expiry());
    await processQueue();
    const w3 = swapWitness({ held: await findLock(3n, 50n * USD), deployment: d.deploymentId, tree: await chainTree(d), pools: [await poolInfo(1n)], asOf: await asOf(), keys });
    const swapTx = await send(KEYS.operator, d.spot, spotAbi, "swap", execSwap(w3, (await swapP.prove(w3.inputs)).proof));
    await processQueue();
    const text = swapTx.logs.map((l) => [...l.topics, l.data].join("")).join("").toLowerCase();
    const word = (x: bigint): string => x.toString(16).padStart(64, "0");
    record("a swap publishes no amount, no reserve and neither wallet", ![50n * USD, w3.out, w3.next[0]!.r0, w3.next[0]!.r1].some((x) => text.includes(word(x))) && !text.includes(bobEoa.slice(2).toLowerCase()) && swapTx.logs.every((l) => l.address.toLowerCase() !== d.usd.toLowerCase()));

    const lpRecords = async (): Promise<{ claim: LpRecord; leafIndex: number }[]> => {
      const owner = await usedAddresses(ALICE_SEED, d);
      const out: { claim: LpRecord; leafIndex: number }[] = [];
      for (const r of await chainRecords(d)) {
        if (r.kind !== RECORD_LP) continue;
        for (const k of owner) {
          const claim = openLp(r.ciphertext.slice(0, LP_CT_LEN), k.encSk, d.deploymentId, r.commitment);
          if (claim && !(await readPool<boolean>(d, "nullifierSpent", [toHex32(recNullifier(r.commitment, claim.recNonce))]))) out.push({ claim, leafIndex: r.leafIndex });
        }
      }
      return out;
    };
    const held = (await lpRecords()).find((x) => x.claim.pool === 1n)!;
    record("a fresh wallet finds its liquidity from seed and chain data", held?.claim.shares === lp1.shares);
    const ownerKey = (await usedAddresses(ALICE_SEED, d)).find((k) => k.pk.x === held.claim.ownerX)!;
    const setFor = async (h: { claim: LpRecord; leafIndex: number }, mode: bigint, sk: bigint, min0: bigint, min1: bigint, exp: bigint) => lpSetWitness({ claim: h.claim, leafIndex: h.leafIndex, deployment: d.deploymentId, tree: await chainTree(d), mode, sk, min0, min1, expiry: exp, asOf: await blockTime(), keys });
    const notOwner = await refuses(setP, (await setFor(held, 0n, bob.sk, 0n, 0n, await expiry())).inputs, "not the owner");
    record("only the owner can request a liquidity removal", notOwner.ok, notOwner);

    const shortRequest = await setFor(held, 0n, ownerKey.sk, 1n, 1n, (await blockTime()) + 60n);
    await send(KEYS.stranger, d.spot, spotAbi, "setLiquidityRequest", [toHex((await setP.prove(shortRequest.inputs)).proof), { ...shortRequest.publicInputs }]);
    await processQueue();
    await warp(120);
    const openNow = (await lpRecords()).find((x) => x.claim.pool === 1n && x.claim.expiry !== 0n)!;
    const restored = await setFor(openNow, 1n, 0n, 0n, 0n, 0n);
    await send(KEYS.stranger, d.spot, spotAbi, "setLiquidityRequest", [toHex((await setP.prove(restored.inputs)).proof), { ...restored.publicInputs }]);
    await processQueue();
    const idle = (await lpRecords()).find((x) => x.claim.pool === 1n && x.claim.expiry === 0n)!;
    record("an ignored removal request returns to an idle position, needing no key", idle?.claim.shares === lp1.shares);

    const state = (await poolInfo(1n)).state;
    const fair0 = (idle.claim.shares * state.r0) / state.supply;
    const fair1 = (idle.claim.shares * state.r1) / state.supply;
    const request = await setFor(idle, 0n, ownerKey.sk, fair0, fair1, await expiry());
    await send(KEYS.stranger, d.spot, spotAbi, "setLiquidityRequest", [toHex((await setP.prove(request.inputs)).proof), { ...request.publicInputs }]);
    await processQueue();
    const open = (await lpRecords()).find((x) => x.claim.pool === 1n && x.claim.expiry !== 0n)!;
    const tooLow = await poolInfo(1n);
    const shrunk = { ...tooLow, state: { ...tooLow.state, r0: tooLow.state.r0 / 2n }, head: poolHead(d.deploymentId, 1n, { ...tooLow.state, r0: tooLow.state.r0 / 2n }) };
    const lowOut = await refuses(removeP, lpRemoveWitness({ claim: open.claim, leafIndex: open.leafIndex, pool: shrunk, deployment: d.deploymentId, tree: await chainTree(d), asOf: await asOf(), keys }).inputs, "below minimum output");
    record("a removal below the owner's minimums cannot be proven", lowOut.ok, lowOut);
    const rem = lpRemoveWitness({ claim: open.claim, leafIndex: open.leafIndex, pool: tooLow, deployment: d.deploymentId, tree: await chainTree(d), asOf: await asOf(), keys });
    await send(KEYS.operator, d.spot, spotAbi, "removeLiquidity", [toHex((await timed("lp_remove", () => removeP.prove(rem.inputs))).proof), { ...rem.publicInputs }]);
    await processQueue();
    const aliceNotes = await restore(ALICE_SEED, d);
    // Without fees the position is worth exactly shares^2 in reserve-product terms, so anything above that is earned.
    record("removal pays the owner both tokens, and swap fees grew the position", rem.out0 * rem.out1 > lp1.shares * lp1.shares && rem.out0 === fair0 && rem.out1 === fair1 && aliceNotes.some((n) => n.asset === BigInt(d.usd) && n.value === fair0) && aliceNotes.some((n) => n.asset === BigInt(d.tokenA) && n.value === fair1) && rem.next.supply === 1000n, { out0: rem.out0, out1: rem.out1 });

    // Custody per token: every token is a live note, a live lock, or in a pool.
    const bobNotes = await restore(BOB_SEED, d);
    const locked = await operatorLocks();
    const [p1Final, p2Final] = await Promise.all([poolInfo(1n), poolInfo(2n)]);
    for (const [name, token, reserves] of [["USDG", d.usd, p1Final.state.r0], ["token A", d.tokenA, p1Final.state.r1 + p2Final.state.r0], ["token B", d.tokenB, p2Final.state.r1]] as const) {
      const notes = [...aliceNotes, ...bobNotes].filter((n) => n.asset === BigInt(token)).reduce((s, n) => s + n.value, 0n);
      const inLocks = locked.filter((h) => h.record.asset === BigInt(token)).reduce((s, h) => s + h.record.amount, 0n);
      const custody = (await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [d.pool] })) as bigint;
      record(`custody of ${name} equals live notes + open locks + pool reserves`, custody === notes + inLocks + reserves, { custody, notes, inLocks, reserves });
    }
  } finally {
    await Promise.all([appendP, lockP, swapP, addP, setP, removeP, releaseP].map((p) => p.destroy()));
  }
  writeFileSync(`${ROOT}docs/privacy/evidence/spot-flow-local.json`, stringify({ note: "Local anvil (31337). Synthetic identities.", steps, gas, proveMs }));
  console.log(`${steps.length} steps passed`, gas, proveMs);
}

await main();
