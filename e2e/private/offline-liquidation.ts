/**
 * W2 experiment (addendum section 17): forced liquidation with both traders offline, from chain data and a risk key
 * only. Real UltraHonk proofs, verified by the generated Solidity verifiers on a dedicated anvil.
 *
 *   anvil --port 8547 &
 *   RPC=http://127.0.0.1:8547 bun run private/offline-liquidation.ts
 *
 * Writes docs/privacy/evidence/w2-offline-liquidation-local.json. Anvil's public test keys and synthetic seeds only.
 *
 * Prototype scope is listed in docs/privacy/ADR-P05-risk-and-liquidation.md.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http, parseAbi, type Abi, type Address, type Hex, type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  APPEND_BATCH, CLAIM_CT_LEN, CLAIM_CT_WINNER, CLOSE_DEAD_ORACLE, CLOSE_MATURED, CLOSE_TAKER, FUNDING_INDEX_ZERO, LOCK_CT_LEN, MARKET_CT_COORDINATOR, MARKET_CT_LEN, MARKET_CT_RISK_A, MARKET_PT_LEN, OI_BATCH, PAIR_CT_LEN, PAIR_CT_MAKER, PAIR_CT_RISK_A, PAIR_CT_RISK_B, PAIR_CT_TAKER, RECORD_CLAIM, RECORD_FREE, RECORD_LOCK, RECORD_PAIR,
  ACTOR_NONE, ACTOR_TAKER, addressOf, marketHead, appendWitness, bondReleaseWitness, closeWitness, decrypt, depositOpening, deriveKeys, exitRequestWitness, fundingEpochWitness, initCrypto, leafOf, liquidateWitness, lockAddressKeys, lockCommitment, lockWitness, makerTerms, pairCommitment, oiDeltaCommitment,
  MerkleTree, mulGenerator, noteInner, openLock, openPair, openPairWitness, Prover, recNullifier, releaseWitness, insuranceSweepWitness, openClaim, redeemWitness, updateWitness, scanCreated, scanDeposits, takerTerms, toHex32,
  type ClaimRecord, type ClosePublic, type CompiledCircuit, type CreatedNotes, type FundingPublic, type HeldLock, type LiquidatePublic, type LockPublic, type MarketState, type OiDelta, type OpenPublic, type OwnedNote, type PairRecord, type Point,
  type QueueEntry, type RedeemPublic, type ReleasePublic, type SweepPublic, type ShieldedDeposit, type UpdatePublic, type WalletKeys,
} from "@rooq/private-sdk";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RPC = process.env.RPC ?? "http://127.0.0.1:8547";
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  alice: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  maker: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  coordinator: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  workerA: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  workerB: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
} as const;
const ALICE_SEED = 0xa11ce5eedn;
const MAKER_SEED = 0x3a4e45eedn;
const COORDINATOR_SK = 0xc0041n;
const RISK_A_SK = 0xa1a1n;
const RISK_B_SK = 0xb2b2n;
const NEW_COORDINATOR_SK = 0xc00420n;
const NEW_RISK_A_SK = 0xa2a2n;
const NEW_RISK_B_SK = 0xb3b3n;
const USD = 1_000_000n;
const WAD = 10n ** 18n;
const SCALE = 10n ** 12n;
const IMR = WAD / 10n;
const MMR = WAD / 20n;
const PENALTY_BPS = 100n;
const MAX_FUNDING = WAD / 20n;
const WORKER_A_SEED = 0x1a5eedn;
const WORKER_B_SEED = 0x1b5eedn;
const FEE_SEED = 0xfee5eedn;
const ADDRESS_GAP = 30;
const CLAIM_CT_RISK_B_SLOT = 2;
/** Keys the operator holds. A rotation appends the new one and keeps the old one for old records (D-24). */
const HELD = { coordinator: [COORDINATOR_SK] as bigint[], riskA: [RISK_A_SK] as bigint[] };

const read = (p: string): string => readFileSync(`${ROOT}${p}`, "utf8");
const artifact = (n: string): Abi => (JSON.parse(read(`contracts/out/${n}.sol/${n}.json`)) as { abi: Abi }).abi;
const circuit = (n: string): CompiledCircuit => JSON.parse(read(`zk/circuits/target/${n}.json`)) as CompiledCircuit;
const poolAbi = artifact("PrivatePairs");
const marketsAbi = artifact("PrivateMarkets");
const erc20 = parseAbi([
  "function mintTo(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)",
]);
const feedAbi = parseAbi(["function setAnswer(int256)"]);

const steps: { step: string; ok: boolean; detail: unknown }[] = [];
const gas: Record<string, string> = {};
const proveMs: Record<string, number> = {};
function record(step: string, ok: boolean, detail: unknown = {}): void {
  steps.push({ step, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${step}`);
  if (!ok) throw new Error(`${step}: ${JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}

const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: foundry, transport: http(RPC) });
const toHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;

async function send(k: Hex, address: Address, abi: Abi, functionName: string, args: readonly unknown[], value = 0n): Promise<TransactionReceipt> {
  const hash = await wallet(k).writeContract({ address, abi, functionName, args, chain: foundry, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  gas[functionName] = r.gasUsed.toString();
  return r;
}

/** Only failures of the proof itself. A wrong input or proof length means the contract built the call wrongly, so it proves nothing. */
const VERIFIER_ERRORS = new Set(["0x9fc3a218", "0xa5d82e8a", "0xa2a2ac83", "0xeb73e0bd", "0x20a33589", "0x607be13e", "0x4ddaa5e5"]);

async function reverts(k: Hex, address: Address, functionName: string, args: readonly unknown[]): Promise<string | null> {
  try {
    await pub.simulateContract({ account: privateKeyToAccount(k), address, abi: [...poolAbi, ...marketsAbi], functionName, args });
    return null;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    const named = /Error: (\w+\(.*?\))/.exec(m)?.[1];
    if (named) return named;
    const sig = /following signature:\s*\n?\s*(0x[0-9a-f]{8})/i.exec(m)?.[1]?.toLowerCase();
    if (sig) return VERIFIER_ERRORS.has(sig) ? `verifier:${sig}` : sig;
    return m.slice(0, 900);
  }
}
const verifierRejected = (r: string | null): boolean => r?.startsWith("verifier:") ?? false;

/** Witness execution must fail on exactly the named constraint; any other failure proves nothing. */
async function refuses(prover: Prover, inputs: Parameters<Prover["prove"]>[0], constraint: string): Promise<{ ok: boolean; message: string }> {
  try {
    await prover.prove(inputs);
    return { ok: false, message: "proof generated" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: message.includes(constraint), message };
  }
}

interface Deployment { pool: Address; markets: Address; thirdFeed: Address; thirdFeedId: Hex; asset: Address; feed: Address; otherFeed: Address; deploymentId: bigint; market: bigint }

function deploy(out: string, coordinator: Point, riskA: Point, riskB: Point, feeTo: WalletKeys): Deployment {
  execFileSync("forge", ["script", "script/DeployPrivatePairs.s.sol", "--rpc-url", RPC, "--broadcast", "--slow", "--silent"], {
    cwd: `${ROOT}contracts`,
    env: {
      ...process.env, DEPLOYER_PRIVATE_KEY: KEYS.deployer, PRIVACY_OUT: out,
      COORDINATOR_X: coordinator.x.toString(), COORDINATOR_Y: coordinator.y.toString(),
      RISK_A_X: riskA.x.toString(), RISK_A_Y: riskA.y.toString(), RISK_B_X: riskB.x.toString(), RISK_B_Y: riskB.y.toString(),
      FEE_AUTH: feeTo.auth.toString(), FEE_X: feeTo.pk.x.toString(), FEE_Y: feeTo.pk.y.toString(),
    },
    stdio: "pipe",
  });
  const d = JSON.parse(readFileSync(out, "utf8")) as { pool: Address; markets: Address; thirdFeed: Address; thirdFeedId: Hex; asset: Address; feed: Address; otherFeed: Address; deploymentId: number | string; market: number };
  return { pool: d.pool, markets: d.markets, thirdFeed: d.thirdFeed, thirdFeedId: d.thirdFeedId, asset: d.asset, feed: d.feed, otherFeed: d.otherFeed, deploymentId: BigInt(d.deploymentId), market: BigInt(d.market) };
}

const readPool = <T>(pool: Address, functionName: string, args: readonly unknown[] = []): Promise<T> =>
  pub.readContract({ address: pool, abi: poolAbi, functionName, args }) as Promise<T>;

async function queue(pool: Address, from: bigint, to: bigint): Promise<QueueEntry[]> {
  const out: QueueEntry[] = [];
  for (let i = from; i < to; i++) {
    const e = await readPool<{ kind: number; a: Hex; b: Hex; c: Hex }>(pool, "queueEntry", [i]);
    out.push({ kind: BigInt(e.kind), a: BigInt(e.a), b: BigInt(e.b), c: BigInt(e.c) });
  }
  return out;
}

async function chainTree(d: Deployment): Promise<MerkleTree> {
  const tree = new MerkleTree();
  for (const e of await queue(d.pool, 0n, await readPool<bigint>(d.pool, "processed"))) tree.insert(leafOf(e, d.deploymentId));
  return tree;
}

async function processQueue(prover: Prover, d: Deployment): Promise<void> {
  for (;;) {
    const [len, done] = await Promise.all([readPool<bigint>(d.pool, "queueLength"), readPool<bigint>(d.pool, "processed")]);
    if (done >= len) return;
    const end = done + BigInt(Math.min(APPEND_BATCH, Number(len - done)));
    const { inputs, newRoot } = appendWitness(await chainTree(d), await queue(d.pool, done, end), d.deploymentId);
    const p = await prover.prove(inputs);
    await send(KEYS.workerB, d.pool, poolAbi, "processQueue", [toHex(p.proof), toHex32(newRoot)]);
  }
}

interface ChainRecord { leafIndex: number; kind: number; commitment: bigint; ciphertext: bigint[] }

async function chainRecords(pool: Address): Promise<ChainRecord[]> {
  const all = await pub.getContractEvents({ address: pool, abi: poolAbi, eventName: "RecordCreated", fromBlock: 0n });
  return all.map((l) => {
    const a = l.args as { leafIndex: bigint; kind: number; commitment: Hex; ciphertext: Hex[] };
    return { leafIndex: Number(a.leafIndex), kind: Number(a.kind), commitment: BigInt(a.commitment), ciphertext: a.ciphertext.map(BigInt) };
  });
}

async function chainDeposits(pool: Address): Promise<ShieldedDeposit[]> {
  const all = await pub.getContractEvents({ address: pool, abi: poolAbi, eventName: "Shielded", fromBlock: 0n });
  return all.map((l) => {
    const a = l.args as { leafIndex: bigint; asset: Address; amount: bigint; inner: Hex };
    return { leafIndex: Number(a.leafIndex), asset: BigInt(a.asset), amount: a.amount, inner: BigInt(a.inner) };
  });
}

type Note = OwnedNote & { keys: WalletKeys };

/** One-time addresses this wallet used, found from its own lock copies encrypted to the main key (D-06). */
async function usedAddresses(seed: bigint, d: Deployment): Promise<WalletKeys[]> {
  const main = deriveKeys(seed);
  const payouts = new Set<bigint>();
  for (const r of await chainRecords(d.pool)) {
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
  const created: CreatedNotes[] = (await chainRecords(d.pool)).filter((r) => r.kind === RECORD_FREE).map((r) => ({
    firstLeafIndex: r.leafIndex, commitments: [r.commitment], ciphertexts: [r.ciphertext],
  }));
  const processed = Number(await readPool<bigint>(d.pool, "processed"));
  const mine: Note[] = scanDeposits(seed, main, d.deploymentId, await chainDeposits(d.pool)).map((n) => ({ ...n, keys: main }));
  for (const keys of [main, ...(await usedAddresses(seed, d))]) {
    mine.push(...scanCreated(keys, d.deploymentId, created).map((n) => ({ ...n, keys })));
  }
  const live: Note[] = [];
  for (const n of mine) {
    if (n.value > 0n && n.leafIndex < processed && !(await readPool<boolean>(d.pool, "nullifierSpent", [toHex32(n.nullifier)]))) live.push(n);
  }
  return live.sort((a, b) => a.leafIndex - b.leafIndex);
}

const sum = (ns: readonly OwnedNote[]): bigint => ns.reduce((s, n) => s + n.value, 0n);

const lockArgs = (proof: Uint8Array, p: LockPublic) => [toHex(proof), { ...p }] as const;
const openArgs = (proof: Uint8Array, p: OpenPublic) => [toHex(proof), { ...p }] as const;
const liqArgs = (proof: Uint8Array, p: LiquidatePublic) => [toHex(proof), { ...p }] as const;
const releaseArgs = (proof: Uint8Array, p: ReleasePublic) => [toHex(proof), { ...p }] as const;
const closeArgs = (proof: Uint8Array, p: ClosePublic) => [toHex(proof), { ...p }] as const;
const redeemArgs = (proof: Uint8Array, p: RedeemPublic) => [toHex(proof), { ...p }] as const;
const sweepArgs = (proof: Uint8Array, p: SweepPublic) => [toHex(proof), { ...p }] as const;
const updateArgs = (proof: Uint8Array, p: UpdatePublic) => [toHex(proof), { ...p }] as const;
const fundingArgs = (proof: Uint8Array, p: FundingPublic) => [toHex(proof), { ...p }] as const;

async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  proveMs[name] = Math.round(performance.now() - t0);
  return r;
}

/** Coordinator's view: the locks it can decrypt and that are still unspent. */
async function openLocks(d: Deployment, sk: bigint): Promise<HeldLock[]> {
  const out: HeldLock[] = [];
  for (const r of await chainRecords(d.pool)) {
    if (r.kind !== RECORD_LOCK) continue;
    const rec = openLock(r.ciphertext.slice(LOCK_CT_LEN, 2 * LOCK_CT_LEN), sk, d.deploymentId, r.commitment);
    if (rec) out.push({ record: rec, leafIndex: r.leafIndex });
  }
  return out;
}

/** A risk worker's whole view of a position: its own ciphertext slot and public chain data. */
async function discoverPairs(d: Deployment, sk: bigint, slot: number): Promise<{ pair: PairRecord; leafIndex: number }[]> {
  const out: { pair: PairRecord; leafIndex: number }[] = [];
  for (const r of await chainRecords(d.pool)) {
    if (r.kind !== RECORD_PAIR) continue;
    const pair = openPair(r.ciphertext.slice(slot * PAIR_CT_LEN, (slot + 1) * PAIR_CT_LEN), sk, d.deploymentId, r.commitment);
    if (pair) out.push({ pair, leafIndex: r.leafIndex });
  }
  return out;
}

/** Rebuilds market state from the latest FundingAdvanced ciphertext: what a restarted worker or coordinator does. */
async function marketFromChain(d: Deployment, sks: bigint | readonly bigint[], slot: number, market = d.market): Promise<MarketState> {
  const all = await pub.getContractEvents({ address: d.pool, abi: poolAbi, eventName: "FundingAdvanced", args: { market }, fromBlock: 0n });
  const last = all.at(-1);
  if (!last) return { longOi: 0n, shortOi: 0n, insurance: 0n, badDebt: 0n, bondUsed: 0n, blind: 0n };
  const args = last.args as { ciphertext: Hex[]; head: Hex };
  const ct = args.ciphertext.map(BigInt).slice(slot * MARKET_CT_LEN, (slot + 1) * MARKET_CT_LEN);
  for (const sk of typeof sks === "bigint" ? [sks] : sks) {
    const [longOi, shortOi, insurance, badDebt, bondUsed, blind] = decrypt(ct, sk, MARKET_PT_LEN) as [bigint, bigint, bigint, bigint, bigint, bigint];
    const state = { longOi, shortOi, insurance, badDebt, bondUsed, blind };
    if (marketHead(d.deploymentId, market, state) === BigInt(args.head)) return state;
  }
  throw new Error(`no held key opens the head of market ${market}`);
}

/** Whether a single key alone can open the market's latest record. */
async function marketOpens(d: Deployment, sk: bigint, slot: number, market = d.market): Promise<boolean> {
  try {
    await marketFromChain(d, sk, slot, market);
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("no held key opens")) return false;
    throw err;
  }
}

/** Claims a key can read: `slot` is CLAIM_CT_WINNER for an owner, or a risk worker's position. */
async function chainClaims(d: Deployment, sk: bigint, slot: number): Promise<{ claim: ClaimRecord; leafIndex: number }[]> {
  const out: { claim: ClaimRecord; leafIndex: number }[] = [];
  for (const r of await chainRecords(d.pool)) {
    if (r.kind !== RECORD_CLAIM) continue;
    const claim = openClaim(r.ciphertext.slice(slot * CLAIM_CT_LEN, (slot + 1) * CLAIM_CT_LEN), sk, d.deploymentId, r.commitment);
    if (claim) out.push({ claim, leafIndex: r.leafIndex });
  }
  return out;
}

/** Opens pending OI commitments using only pairs the worker can read. */
async function pendingDeltas(d: Deployment, sks: bigint | readonly bigint[], slot: number, market = d.market): Promise<{ opening: OiDelta; commitment: bigint }[]> {
  const openings = new Map<bigint, OiDelta>();
  const keys = typeof sks === "bigint" ? [sks] : sks;
  const pairs = (await Promise.all(keys.map((sk) => discoverPairs(d, sk, slot)))).flat();
  const claims = (await Promise.all(keys.map((sk) => chainClaims(d, sk, slot - 1)))).flat();
  // Risk workers hold positions 2 and 3 of a pair's ciphertexts and 1 and 2 of a claim's.
  for (const { claim: c } of claims) {
    const parent = pairs.find((x) => x.pair.recNonce === c.pairNonce);
    if (!parent) throw new Error("claim without a readable pair");
    openings.set(c.deltaCm, { isShort: parent.pair.isShort, size: parent.pair.size, remove: 1n, recNonce: c.pairNonce, insIn: c.insIn, claim: c.amount });
  }
  for (const { pair: p } of pairs) {
    // A version's nonce opens its open, its full close, and the partial reduce that created it.
    for (const [size, remove] of [[p.size, 0n], [p.size, 1n], [p.lastReduce, 1n]] as const) {
      openings.set(oiDeltaCommitment(d.deploymentId, p.market, p.isShort, size, remove, p.recNonce), { isShort: p.isShort, size, remove, recNonce: p.recNonce });
    }
  }
  const [count, st] = await Promise.all([readPool<bigint>(d.pool, "oiDeltaCount", [market]), readPool<{ consumed: bigint }>(d.pool, "funding", [market])]);
  const out: { opening: OiDelta; commitment: bigint }[] = [];
  for (let i = st.consumed; i < count && out.length < OI_BATCH; i++) {
    const commitment = BigInt(await readPool<Hex>(d.pool, "oiDelta", [market, i]));
    const opening = openings.get(commitment);
    if (!opening) throw new Error(`no opening for open-interest change ${i}`);
    out.push({ opening, commitment });
  }
  return out;
}

const blockTime = async (): Promise<bigint> => (await pub.getBlock()).timestamp;
const setPrice = (d: Deployment, usd: bigint) => send(KEYS.deployer, d.feed, feedAbi as Abi, "setAnswer", [usd * 100_000_000n]);
const fundingIndex = async (d: Deployment, market = d.market): Promise<bigint> => (await readPool<{ index: bigint }>(d.pool, "funding", [market])).index;
interface MarketParams { takerFeeBps: bigint; maxOiUsdWad: bigint; maxPairSize: bigint }
const marketParams = (d: Deployment, market: bigint): Promise<MarketParams> => readPool<MarketParams>(d.pool, "market", [market]);
async function openLimits(d: Deployment, market: bigint, feeTo: WalletKeys) {
  const [params, st, count] = await Promise.all([marketParams(d, market), readPool<{ head: Hex; consumed: bigint }>(d.pool, "funding", [market]), readPool<bigint>(d.pool, "oiDeltaCount", [market])]);
  return {
    feeBps: params.takerFeeBps, feeTo: addressOf(feeTo), head: BigInt(st.head), state: await marketFromChain(d, HELD.coordinator, MARKET_CT_COORDINATOR, market),
    oiPending: (count - st.consumed) * params.maxPairSize, maxOiUsd: params.maxOiUsdWad, maxPairSize: params.maxPairSize,
  };
}
const warp = async (seconds: number): Promise<void> => {
  await pub.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
  await pub.request({ method: "evm_mine" as never, params: [] as never });
};

async function main(): Promise<void> {
  await initCrypto();
  record("dedicated local chain", (await pub.getChainId()) === 31337);
  let riskA = mulGenerator(RISK_A_SK);
  let riskB = mulGenerator(RISK_B_SK);
  let coordinator = mulGenerator(COORDINATOR_SK);
  const feeWallet = deriveKeys(FEE_SEED);
  const d = deploy(`${ROOT}contracts/deployments/privacy-e2e-pairs.json`, coordinator, riskA, riskB, feeWallet);
  record("deploy PrivatePairs with two risk keys and a coordinator key fixed at construction", true, { pool: d.pool });

  const load = (c: string): Promise<Prover> => Prover.create(circuit(c));
  const [appendP, lockP, openP, liqP, relP, epochP, closeP, exitP, updateP, redeemP, sweepP] = await Promise.all([
    load("append"), load("lock"), load("open_pair"), load("liquidate"), load("release"), load("funding_epoch"), load("close_pair"), load("exit_request"), load("pair_update"), load("redeem_claim"), load("insurance_sweep"),
  ]);
  try {
    const alice = deriveKeys(ALICE_SEED);
    const maker = deriveKeys(MAKER_SEED);
    const aliceEoa = privateKeyToAccount(KEYS.alice).address;
    const makerEoa = privateKeyToAccount(KEYS.maker).address;
    const workerWallets = { A: deriveKeys(WORKER_A_SEED), B: deriveKeys(WORKER_B_SEED) };
    const nextAddress = { alice: 0, maker: 0 };
    const payoutFor = (who: "alice" | "maker") => addressOf(lockAddressKeys(who === "alice" ? ALICE_SEED : MAKER_SEED, nextAddress[who]++));

    const fund = async (k: Hex, eoa: Address, seed: bigint, owner: bigint, start: number, amounts: readonly bigint[]) => {
      const total = amounts.reduce((a, b) => a + b, 0n);
      await send(KEYS.deployer, d.asset, erc20 as Abi, "mintTo", [eoa, total]);
      await send(k, d.asset, erc20 as Abi, "approve", [d.pool, total]);
      for (const [i, amount] of amounts.entries()) {
        const { rho, blind } = depositOpening(seed, start + i);
        await send(k, d.pool, poolAbi, "shield", [d.asset, amount, toHex32(noteInner(owner, rho, blind))]);
      }
    };
    await fund(KEYS.alice, aliceEoa, ALICE_SEED, alice.owner, 0, [150n * USD, 45n * USD, 100n * USD, 30n * USD]);
    await fund(KEYS.maker, makerEoa, MAKER_SEED, maker.owner, 0, [500n * USD, 200n * USD, 200n * USD]);
    await processQueue(appendP, d);
    record("alice and the maker shield; queue processed permissionlessly", true);

    const lockNote = async (who: "alice" | "maker", note: Note, amount: bigint, terms: ReturnType<typeof takerTerms>, expiry: bigint, name: string): Promise<void> => {
      const view = (who === "alice" ? alice : maker).pk;
      const w = lockWitness({ keys: note.keys, deployment: d.deploymentId, tree: await chainTree(d), asset: BigInt(d.asset), inputs: [note], amount, terms, expiry, coordinator, riskKeys: [riskA, riskB], payout: payoutFor(who), view });
      const p = await timed(name, () => lockP.prove(w.inputs));
      await send(KEYS.workerB, d.pool, poolAbi, "lock", lockArgs(p.proof, w.publicInputs));
    };

    const aliceNotes = await restore(ALICE_SEED, d);
    const makerNotes = await restore(MAKER_SEED, d);
    record("both wallets find their deposits", aliceNotes.length === 4 && makerNotes.length === 3);
    const expiry = (await blockTime()) + 3600n;
    await lockNote("alice", aliceNotes[0]!, 150n * USD, takerTerms(d.market, false, 4n * WAD, 260n * WAD), expiry, "lock");
    await lockNote("maker", makerNotes[0]!, 500n * USD, makerTerms(d.market, 20n, 100n * WAD, 30n), expiry, "lock");
    await processQueue(appendP, d);

    const findLock = async (role: bigint, amount: bigint): Promise<HeldLock> => {
      const held = (await Promise.all(HELD.coordinator.map((sk) => openLocks(d, sk)))).flat().sort((a, b) => a.leafIndex - b.leafIndex);
      for (const h of held.reverse()) {
        const nf = recNullifier(lockCommitment(d.deploymentId, h.record), h.record.recNonce);
        if (h.record.role === role && h.record.amount === amount && !(await readPool<boolean>(d.pool, "nullifierSpent", [toHex32(nf)]))) return h;
      }
      throw new Error("lock not found");
    };

    // Opening: adversarial coordinator first.
    let riskKeys: readonly [Point, Point] = [riskA, riskB];
    const openParams = async (mark: bigint, market = d.market) => ({
      deployment: d.deploymentId, tree: await chainTree(d), mark, asOf: (await blockTime()) + 600n, imrWad: IMR, scale: SCALE, riskKeys,
      fundingIndex: await fundingIndex(d, market), limits: await openLimits(d, market, feeWallet),
    });
    let taker = await findLock(1n, 150n * USD);
    let mk = await findLock(2n, 500n * USD);

    const forgedSize = openPairWitness({ ...(await openParams(250n * WAD)), taker: { ...taker, record: { ...taker.record, t3: 40n * WAD } }, maker: mk, makerMargin: 120n * USD });
    const sizeRefused = await refuses(openP, forgedSize.inputs, "lock not in tree");
    record("coordinator cannot change the taker's committed size", sizeRefused.ok, sizeRefused);

    const overLimit = openPairWitness({ ...(await openParams(262n * WAD)), taker, maker: mk, makerMargin: 120n * USD });
    const limitRefused = await refuses(openP, overLimit.inputs, "fill above taker limit");
    record("fill beyond the taker's limit price cannot be proven", limitRefused.ok, limitRefused);

    const underMargin = openPairWitness({ ...(await openParams(250n * WAD)), taker, maker: mk, makerMargin: 50n * USD });
    const marginRefused = await refuses(openP, underMargin.inputs, "maker below initial margin");
    record("maker below initial margin cannot be proven", marginRefused.ok, marginRefused);

    const rogueKey = mulGenerator(0xbadn);
    const rogue = openPairWitness({ ...(await openParams(250n * WAD)), taker, maker: mk, makerMargin: 120n * USD, riskKeys: [rogueKey, riskB] });
    const rogueProof = await openP.prove(rogue.inputs);
    const rogueResult = await reverts(KEYS.coordinator, d.pool, "openPair", openArgs(rogueProof.proof, rogue.publicInputs));
    record("position encrypted to a coordinator-chosen risk key is rejected by the verifier (LIQ-04)", verifierRejected(rogueResult), { rogueResult });

    const good = openPairWitness({ ...(await openParams(250n * WAD)), taker, maker: mk, makerMargin: 120n * USD });
    const goodProof = await timed("open_pair", () => openP.prove(good.inputs));
    const garbled = good.publicInputs.pairCt.map((c, i) => (i === PAIR_CT_RISK_A ? c.map((x, j) => (j === 5 ? toHex32(BigInt(x) + 1n) : x)) : [...c]));
    const garbledResult = await reverts(KEYS.coordinator, d.pool, "openPair", openArgs(goodProof.proof, { ...good.publicInputs, pairCt: garbled }));
    record("garbled risk ciphertext is rejected by the verifier (REC-01)", verifierRejected(garbledResult), { garbledResult });

    await send(KEYS.coordinator, d.pool, poolAbi, "openPair", openArgs(goodProof.proof, good.publicInputs));
    await processQueue(appendP, d);
    record("pair opens at mark 250 + 20 bps with no trader online", good.record.entry === (250n * WAD * 10_020n) / 10_000n, { entry: good.record.entry.toString() });

    // Both traders are now treated as gone: nothing below reads alice's or the maker's keys or memory until restore.
    const workers = [
      { name: "A", sk: RISK_A_SK, slot: PAIR_CT_RISK_A, key: KEYS.workerA, wallet: workerWallets.A },
      { name: "B", sk: RISK_B_SK, slot: PAIR_CT_RISK_B, key: KEYS.workerB, wallet: workerWallets.B },
    ] as const;
    const views = await Promise.all(workers.map((w) => discoverPairs(d, w.sk, w.slot)));
    record("both risk workers independently decrypt the pair from chain data", views[0]!.length === 1 && views[1]!.length === 1
      && views[0]![0]!.pair.size === 4n * WAD && views[1]![0]!.pair.recNonce === views[0]![0]!.pair.recNonce);
    const ownSlots = await Promise.all([discoverPairs(d, lockAddressKeys(ALICE_SEED, 0).encSk, PAIR_CT_TAKER), discoverPairs(d, lockAddressKeys(MAKER_SEED, 0).encSk, PAIR_CT_MAKER)]);
    record("taker and maker each read the pair with their one-time key", ownSlots.every((v) => v.length === 1 && v[0]!.pair.size === 4n * WAD));
    const seen = views[0]![0]!.pair;
    record("the pair holds one-time addresses, not either wallet's main key (D-06)", seen.takerX !== alice.pk.x && seen.makerX !== maker.pk.x && seen.takerAuth !== alice.auth);
    const stranger = await discoverPairs(d, 0xdeadn, PAIR_CT_RISK_A);
    record("a key that is not a risk key discovers nothing", stranger.length === 0);

    const { pair, leafIndex } = views[0]![0]!;
    const liq = async (p: PairRecord, index: number, mark: bigint, liquidator: WalletKeys) => liquidateWitness({
      pair: p, leafIndex: index, deployment: d.deploymentId, tree: await chainTree(d), mark, mmrWad: MMR, penaltyBps: PENALTY_BPS, scale: SCALE,
      riskKeys, fundingIndex: await fundingIndex(d), liquidator: addressOf(liquidator),
    });

    const healthy = await liq(pair, leafIndex, 250n * WAD, workerWallets.A);
    record("the reference model says the pair is healthy at 250", !healthy.outcome.takerBad && !healthy.outcome.makerBad);
    const healthyRefused = await refuses(liqP, healthy.inputs, "pair is healthy");
    record("healthy pair cannot be liquidated (no proof exists)", healthyRefused.ok, healthyRefused);

    await setPrice(d, 210n);
    const oldPriceW = await liq(pair, leafIndex, 210n * WAD, workerWallets.A);
    const oldPrice = await liqP.prove(oldPriceW.inputs);
    await setPrice(d, 218n);
    const oldResult = await reverts(KEYS.workerA, d.pool, "liquidate", liqArgs(oldPrice.proof, oldPriceW.publicInputs));
    record("proof at a cherry-picked earlier price is rejected", verifierRejected(oldResult), { oldResult });

    const w = await liq(pair, leafIndex, 218n * WAD, workerWallets.A);
    record("liquidatable at 218 per reference model", w.outcome.takerBad && !w.outcome.makerBad, w.outcome);
    const proof = await timed("liquidate", () => liqP.prove(w.inputs));

    const unknownMarket = await reverts(KEYS.workerA, d.pool, "liquidate", liqArgs(proof.proof, { ...w.publicInputs, market: 3n }));
    record("unknown market is rejected", unknownMarket?.includes("UnknownMarket") ?? false, { unknownMarket });
    // Market 2 is live and its feed reads the same 218, so only the market id bound in the proof can refuse this.
    const wrongMarket = await reverts(KEYS.workerA, d.pool, "liquidate", liqArgs(proof.proof, { ...w.publicInputs, market: 2n }));
    record("a proof for one market is rejected on another live market at the same price (LIQ-03)", verifierRejected(wrongMarket), { wrongMarket });
    const redirected = w.publicInputs.commitments.map((c, i) => (i === 2 ? toHex32(BigInt(c) + 1n) : c)) as unknown as LiquidatePublic["commitments"];
    const frontRun = await reverts(KEYS.workerB, d.pool, "liquidate", liqArgs(proof.proof, { ...w.publicInputs, commitments: redirected }));
    record("changing the reward note is rejected by the verifier", verifierRejected(frontRun), { frontRun });
    const bumped = await reverts(KEYS.workerA, d.pool, "liquidate", liqArgs(proof.proof, { ...w.publicInputs, deltaCommitment: toHex32(BigInt(w.publicInputs.deltaCommitment) + 1n) }));
    record("changing the hidden insurance change is rejected by the verifier", verifierRejected(bumped), { bumped });

    // Worker B independently proves the same pair; once A lands, the shared nullifier must refuse B.
    const bWitness = await liq(views[1]![0]!.pair, views[1]![0]!.leafIndex, 218n * WAD, workers[1].wallet);
    const bProof = await liqP.prove(bWitness.inputs);

    const liqTx = await send(KEYS.workerA, d.pool, poolAbi, "liquidate", liqArgs(proof.proof, w.publicInputs));
    const tokenMoves = liqTx.logs.filter((l) => l.address.toLowerCase() === d.asset.toLowerCase()).length;
    record("worker A liquidates with both traders offline; no public token movement (D-07)", tokenMoves === 0 && w.outcome.reward === 4_360_000n, { reward: w.outcome.reward.toString() });
    await processQueue(appendP, d);

    const workerNotes = await restore(WORKER_A_SEED, d);
    record("worker A's reward arrives as a shielded note", sum(workerNotes) === w.outcome.reward, { value: sum(workerNotes).toString() });

    const duplicate = await reverts(KEYS.workerB, d.pool, "liquidate", liqArgs(bProof.proof, bWitness.publicInputs));
    record("second worker's proof for the same pair is rejected (shared nullifier)", duplicate?.includes("NullifierSpent") ?? false, { duplicate });
    const word = (x: bigint): string => x.toString(16).padStart(64, "0");
    const published = liqTx.logs.map((l) => [...l.topics, l.data].join("")).join("").toLowerCase();
    record("a liquidation publishes no reward, insurance or payout amount (D-07)", [w.outcome.reward, w.outcome.toInsurance, w.outcome.takerOut, w.outcome.makerOut].every((x) => !published.includes(word(x))));

    // Restore after offline settlement.
    const aliceAfter = await restore(ALICE_SEED, d);
    const makerAfter = await restore(MAKER_SEED, d);
    const aliceLiq = aliceAfter.find((n) => n.value === w.outcome.takerOut);
    const makerLiq = makerAfter.find((n) => n.value === w.outcome.makerOut);
    record("offline owners recover forced outputs from seed and chain data (REC-02)", !!aliceLiq && !!makerLiq, { takerOut: w.outcome.takerOut.toString(), makerOut: w.outcome.makerOut.toString() });

    // Short taker, price spikes through the margin: the winner gets a claim for the shortfall.
    await setPrice(d, 200n);
    const aliceN2 = aliceAfter.find((n) => n.value === 45n * USD)!;
    const makerN2 = makerAfter.find((n) => n.value === 200n * USD)!;
    const exp2 = (await blockTime()) + 3600n;
    await lockNote("alice", aliceN2, 45n * USD, takerTerms(d.market, true, 2n * WAD, 190n * WAD), exp2, "lock");
    await lockNote("maker", makerN2, 200n * USD, makerTerms(d.market, 20n, 100n * WAD, 30n), exp2, "lock");
    await processQueue(appendP, d);
    taker = await findLock(1n, 45n * USD);
    mk = await findLock(2n, 200n * USD);
    const open2 = openPairWitness({ ...(await openParams(200n * WAD)), taker, maker: mk, makerMargin: 60n * USD });
    await send(KEYS.coordinator, d.pool, poolAbi, "openPair", openArgs((await openP.prove(open2.inputs)).proof, open2.publicInputs));
    await processQueue(appendP, d);
    record("short taker pair opens at mark 200 - 20 bps", open2.record.entry === 1996n * WAD / 10n && open2.record.isShort === 1n);

    await setPrice(d, 240n);
    const v2 = (await discoverPairs(d, RISK_B_SK, PAIR_CT_RISK_B)).find((x) => x.pair.size === 2n * WAD)!;
    const w2 = await liq(v2.pair, v2.leafIndex, 240n * WAD, workerWallets.A);
    record("loss beyond margin becomes a claim for the winner", w2.outcome.takerOut === 0n && w2.outcome.claim === 80_800_000n - 45n * USD, w2.outcome);
    await send(KEYS.workerB, d.pool, poolAbi, "liquidate", liqArgs((await liqP.prove(w2.inputs)).proof, w2.publicInputs));
    await processQueue(appendP, d);
    record("worker B force-closes the short (failover path)", (await chainClaims(d, RISK_B_SK, CLAIM_CT_RISK_B_SLOT)).some((x) => x.claim.amount === w2.outcome.claim));

    // Maker is the unhealthy side.
    await setPrice(d, 100n);
    const a3 = await restore(ALICE_SEED, d);
    const m3 = await restore(MAKER_SEED, d);
    const exp3 = (await blockTime()) + 3600n;
    await lockNote("alice", a3.find((n) => n.value === 100n * USD)!, 100n * USD, takerTerms(d.market, false, 5n * WAD, 101n * WAD), exp3, "lock");
    await lockNote("maker", m3.find((n) => n.value === 200n * USD)!, 200n * USD, makerTerms(d.market, 20n, 100n * WAD, 30n), exp3, "lock");
    await processQueue(appendP, d);
    taker = await findLock(1n, 100n * USD);
    mk = await findLock(2n, 200n * USD);
    const open3 = openPairWitness({ ...(await openParams(100n * WAD)), taker, maker: mk, makerMargin: 55n * USD });
    await send(KEYS.coordinator, d.pool, poolAbi, "openPair", openArgs((await openP.prove(open3.inputs)).proof, open3.publicInputs));
    await processQueue(appendP, d);
    await setPrice(d, 108n);
    const v3 = (await discoverPairs(d, RISK_A_SK, PAIR_CT_RISK_A)).find((x) => x.pair.size === 5n * WAD)!;
    const w3 = await liq(v3.pair, v3.leafIndex, 108n * WAD, workerWallets.A);
    record("maker is the unhealthy side at 108", !w3.outcome.takerBad && w3.outcome.makerBad, w3.outcome);
    await send(KEYS.workerA, d.pool, poolAbi, "liquidate", liqArgs((await liqP.prove(w3.inputs)).proof, w3.publicInputs));
    await processQueue(appendP, d);
    record("maker side liquidated; taker receives margin plus gain", w3.outcome.takerOut === 139n * USD, { takerOut: w3.outcome.takerOut.toString() });

    // A lock nobody matches comes back to its offline owner after expiry.
    const a4 = await restore(ALICE_SEED, d);
    const shortExpiry = (await blockTime()) + 120n;
    await lockNote("alice", a4.find((n) => n.value === 30n * USD)!, 30n * USD, takerTerms(d.market, false, WAD, 200n * WAD), shortExpiry, "lock");
    const m4 = await restore(MAKER_SEED, d);
    const backing = m4.find((n) => n.value === 380n * USD)!;
    await lockNote("maker", backing, 50n * USD, makerTerms(d.market, 20n, 100n * WAD, 30n), shortExpiry + 86_400n, "lock");
    await processQueue(appendP, d);
    const parked = await findLock(1n, 30n * USD);
    const liveMaker = await findLock(2n, 50n * USD);
    const early = releaseWitness({ held: parked, deployment: d.deploymentId, tree: await chainTree(d), asOf: await blockTime() });
    const earlyRefused = await refuses(relP, early.inputs, "lock not expired");
    record("an unexpired lock cannot be released", earlyRefused.ok, earlyRefused);
    await warp(600);
    await setPrice(d, 108n);
    const lateOpen = openPairWitness({ ...(await openParams(108n * WAD)), taker: parked, maker: liveMaker, makerMargin: 12n * USD });
    const expiredRefused = await refuses(openP, lateOpen.inputs, "taker lock expired");
    record("an expired lock cannot be matched", expiredRefused.ok, expiredRefused);
    const now = await blockTime();
    // The coordinator is treated as gone: the refund uses the owner's own ciphertext, restored from seed.
    const ownerView = (await chainRecords(d.pool)).filter((r) => r.kind === RECORD_LOCK)
      .map((r) => ({ leafIndex: r.leafIndex, record: openLock(r.ciphertext.slice(0, LOCK_CT_LEN), deriveKeys(ALICE_SEED).encSk, d.deploymentId, r.commitment) }))
      .find((h) => h.record?.amount === 30n * USD);
    record("the owner reads its own lock from chain data without the coordinator", ownerView?.leafIndex === parked.leafIndex && ownerView.record !== null);
    const rel = releaseWitness({ held: { record: ownerView!.record!, leafIndex: ownerView!.leafIndex }, deployment: d.deploymentId, tree: await chainTree(d), asOf: now });
    const relProof = await timed("release", () => relP.prove(rel.inputs));
    const future = await reverts(KEYS.coordinator, d.pool, "release", releaseArgs(relProof.proof, { ...rel.publicInputs, asOf: now + 100_000n }));
    record("release with a future timestamp is rejected", future?.includes("StaleAsOf") ?? false, { future });
    await send(KEYS.coordinator, d.pool, poolAbi, "release", releaseArgs(relProof.proof, rel.publicInputs));
    await processQueue(appendP, d);

    record("expired lock refunded to its offline owner", (await restore(ALICE_SEED, d)).some((n) => n.value === 30n * USD));

    // Funding (D-03, D-08). The queue is folded by a worker that holds only a risk key and chain data.
    const epoch = async (mark: bigint, market = d.market) => {
      const [st, asOf] = await Promise.all([readPool<{ lastEpoch: bigint; head: Hex }>(d.pool, "funding", [market]), blockTime()]);
      const elapsed = asOf - st.lastEpoch;
      return fundingEpochWitness({
        deployment: d.deploymentId, market, state: await marketFromChain(d, HELD.riskA, MARKET_CT_RISK_A, market), head: BigInt(st.head),
        deltas: await pendingDeltas(d, HELD.riskA, PAIR_CT_RISK_A, market), asOf, dt: elapsed > 3600n ? 3600n : elapsed, mark, maxRateWad: MAX_FUNDING, keys: [coordinator, riskA, riskB],
      });
    };
    await setPrice(d, 100n);
    const drain = await epoch(100n * WAD);
    record("three liquidated pairs fold back to zero open interest", drain.next.longOi === 0n && drain.next.shortOi === 0n, { folded: drain.inputs.count });
    const inflow = w.outcome.toInsurance + w3.outcome.toInsurance;
    const claimed = w2.outcome.claim;
    const expectRatio = (inflow * WAD) / claimed;
    const expectPaid = (claimed * expectRatio) / WAD;
    record("insurance pays the shortfall pro rata and the rest stays private bad debt",
      drain.publicInputs.claimRatio === expectRatio && drain.next.insurance === inflow - expectPaid && drain.next.badDebt === claimed - expectPaid,
      { ratio: expectRatio.toString(), paid: expectPaid.toString(), badDebt: (claimed - expectPaid).toString() });
    await send(KEYS.workerB, d.pool, poolAbi, "advanceFunding", fundingArgs((await epochP.prove(drain.inputs)).proof, drain.publicInputs));

    const makerClaim = (await chainClaims(d, RISK_A_SK, 1)).find((x) => x.claim.amount === claimed)!;
    const winnerKey = await usedAddresses(MAKER_SEED, d).then((ks) => ks.find((k) => k.pk.x === makerClaim.claim.ownerX)!);
    const ownerRead = await chainClaims(d, winnerKey.encSk, CLAIM_CT_WINNER);
    record("the winner reads its claim with its one-time key", ownerRead.some((x) => x.claim.amount === claimed));
    const onchainRatio = (await readPool<bigint>(d.pool, "foldedRatioPlusOne", [toHex32(makerClaim.claim.deltaCm)])) - 1n;
    const greedy = redeemWitness({ claim: makerClaim.claim, leafIndex: makerClaim.leafIndex, deployment: d.deploymentId, tree: await chainTree(d), ratio: WAD });
    const greedyResult = await reverts(KEYS.workerB, d.markets, "redeemClaim", redeemArgs((await redeemP.prove(greedy.inputs)).proof, greedy.publicInputs));
    record("a claim cannot be redeemed at a better ratio than its epoch's", verifierRejected(greedyResult), { greedyResult });
    const redeem = redeemWitness({ claim: makerClaim.claim, leafIndex: makerClaim.leafIndex, deployment: d.deploymentId, tree: await chainTree(d), ratio: onchainRatio });
    const redeemProof = await timed("redeem_claim", () => redeemP.prove(redeem.inputs));
    await send(KEYS.workerB, d.markets, marketsAbi, "redeemClaim", redeemArgs(redeemProof.proof, redeem.publicInputs));
    await processQueue(appendP, d);
    const twice = await reverts(KEYS.workerB, d.markets, "redeemClaim", redeemArgs(redeemProof.proof, redeem.publicInputs));
    record("a claim is paid once, to its owner, from chain data alone", redeem.value === expectPaid && (twice?.includes("NullifierSpent") ?? false) && (await restore(MAKER_SEED, d)).some((n) => n.value === expectPaid), { paid: redeem.value.toString(), twice });
    await warp(2);
    const claimedOi = await epoch(100n * WAD);
    claimedOi.inputs.long_oi = toHex32(7n * WAD);
    const oiRefused = await refuses(epochP, claimedOi.inputs, "head mismatch");
    record("a worker cannot claim different open interest", oiRefused.ok, oiRefused);

    const noteOf = async (seed: bigint, value: bigint): Promise<Note> => {
      const n = (await restore(seed, d)).find((x) => x.value === value);
      if (!n) throw new Error(`note of ${value} not found`);
      return n;
    };
    const exp4 = (await blockTime()) + 86_400n;
    await lockNote("alice", await noteOf(ALICE_SEED, 139n * USD), 31n * USD, takerTerms(d.market, false, 3n * WAD, 101n * WAD), exp4, "lock");
    await lockNote("maker", await noteOf(MAKER_SEED, 330n * USD), 100n * USD, makerTerms(d.market, 20n, 100n * WAD, 30n), exp4, "lock");
    await processQueue(appendP, d);
    const open4 = openPairWitness({ ...(await openParams(100n * WAD)), taker: await findLock(1n, 31n * USD), maker: await findLock(2n, 100n * USD), makerMargin: 100n * USD });
    await send(KEYS.coordinator, d.pool, poolAbi, "openPair", openArgs((await openP.prove(open4.inputs)).proof, open4.publicInputs));
    await processQueue(appendP, d);
    record("a position opens with the current funding index as its snapshot", open4.record.fundingIndex === FUNDING_INDEX_ZERO);

    await warp(2);
    const fold = await epoch(100n * WAD);
    record("the new position does not earn funding for the epoch it was folded in", fold.publicInputs.indexMag === 0n && fold.next.longOi === 3n * WAD);
    await send(KEYS.workerA, d.pool, poolAbi, "advanceFunding", fundingArgs((await timed("funding_epoch", () => epochP.prove(fold.inputs))).proof, fold.publicInputs));

    const PER_SECOND = MAX_FUNDING / 3600n;
    const EXPECTED_STEP = (PER_SECOND * 3600n * (100n * WAD)) / WAD;
    for (let i = 0; i < 3; i++) {
      await warp(3700);
      await setPrice(d, 100n);
      const e = await epoch(100n * WAD);
      if (i === 0) {
        record("a one-sided market accrues the capped hour at the full rate", e.publicInputs.indexMag === EXPECTED_STEP && e.publicInputs.indexNeg === 0n, { mag: e.publicInputs.indexMag.toString() });
        const p0 = await epochP.prove(e.inputs);
        const tampered = await reverts(KEYS.workerA, d.pool, "advanceFunding", fundingArgs(p0.proof, { ...e.publicInputs, indexMag: e.publicInputs.indexMag + 1n }));
        record("a changed funding index is rejected by the verifier", verifierRejected(tampered), { tampered });
        await send(KEYS.workerA, d.pool, poolAbi, "advanceFunding", fundingArgs(p0.proof, e.publicInputs));
      } else {
        await send(KEYS.workerA, d.pool, poolAbi, "advanceFunding", fundingArgs((await epochP.prove(e.inputs)).proof, e.publicInputs));
      }
    }
    await setPrice(d, 101n);
    const v4 = (await discoverPairs(d, RISK_A_SK, PAIR_CT_RISK_A)).find((x) => x.pair.size === 3n * WAD)!;
    const w4 = await liq(v4.pair, v4.leafIndex, 101n * WAD, workerWallets.A);
    const wantOwed = (3n * WAD * (3n * EXPECTED_STEP) - 1n) / (WAD * SCALE) + 1n;
    const gain = (3n * WAD * (101n * WAD - v4.pair.entry)) / (WAD * SCALE);
    record("funding owed matches an independent computation and exceeds the taker's margin",
      w4.outcome.takerPaysFunding && w4.outcome.fundingOwed === wantOwed && w4.outcome.fundingPaid === 31n * USD, { owed: wantOwed.toString() });
    record("a winning payer's gain is netted against its unpaid funding (D-03)",
      w4.outcome.fundingNetted === gain && w4.outcome.takerBad && w4.outcome.takerOut === 0n && w4.outcome.makerOut === 131n * USD
        && w4.outcome.fundingWrittenOff === wantOwed - 31n * USD - gain, { gain: gain.toString(), netted: w4.outcome.fundingNetted.toString(), writtenOff: w4.outcome.fundingWrittenOff.toString() });
    await send(KEYS.workerA, d.pool, poolAbi, "liquidate", liqArgs((await liqP.prove(w4.inputs)).proof, w4.publicInputs));
    await processQueue(appendP, d);
    record("the funding receiver is paid from chain data alone", (await restore(MAKER_SEED, d)).some((n) => n.value === 131n * USD));

    // Owner close and forced exit (D-10, D-11). A maker that has gone away cannot trap a taker, and vice versa.
    await setPrice(d, 100n);
    await fund(KEYS.alice, aliceEoa, ALICE_SEED, alice.owner, 4, [51n * USD, 52n * USD, 53n * USD]);
    await fund(KEYS.maker, makerEoa, MAKER_SEED, maker.owner, 3, [211n * USD, 212n * USD, 213n * USD]);
    await processQueue(appendP, d);
    const keysFor = async (seed: bigint, x: bigint): Promise<WalletKeys> => {
      const k = (await usedAddresses(seed, d)).find((a) => a.pk.x === x);
      if (!k) throw new Error("one-time key not found");
      return k;
    };
    const openFor = async (takerValue: bigint, isShort: boolean, size: bigint, limit: bigint, makerValue: bigint, mark: bigint) => {
      const expires = (await blockTime()) + 90n * 86_400n;
      await lockNote("alice", await noteOf(ALICE_SEED, takerValue), takerValue, takerTerms(d.market, isShort, size, limit), expires, "lock");
      await lockNote("maker", await noteOf(MAKER_SEED, makerValue), makerValue, makerTerms(d.market, 20n, 100n * WAD, 30n), expires, "lock");
      await processQueue(appendP, d);
      const o = openPairWitness({ ...(await openParams(mark)), taker: await findLock(1n, takerValue), maker: await findLock(2n, makerValue), makerMargin: 60n * USD });
      await send(KEYS.coordinator, d.pool, poolAbi, "openPair", openArgs((await openP.prove(o.inputs)).proof, o.publicInputs));
      await processQueue(appendP, d);
      const found = (await discoverPairs(d, RISK_A_SK, PAIR_CT_RISK_A)).find((x) => x.pair.recNonce === o.record.recNonce);
      if (!found) throw new Error("opened pair not found");
      return found;
    };
    const closeFor = async (held: { pair: PairRecord; leafIndex: number }, mode: bigint, mark: bigint, sk: bigint) => closeWitness({
      pair: held.pair, leafIndex: held.leafIndex, deployment: d.deploymentId, tree: await chainTree(d), mode, mark, scale: SCALE, fundingIndex: await fundingIndex(d, held.pair.market), sk,
      feeBps: (await marketParams(d, held.pair.market)).takerFeeBps, feeTo: addressOf(feeWallet),
    });

    const a = await openFor(51n * USD, false, 2n * WAD, 101n * WAD, 211n * USD, 100n * WAD);
    await setPrice(d, 110n);
    const takerA = await keysFor(ALICE_SEED, a.pair.takerX);
    const notTaker = await refuses(closeP, (await closeFor(a, CLOSE_TAKER, 110n * WAD, workerWallets.A.sk)).inputs, "not the taker");
    record("only the taker's key can use the taker close", notTaker.ok, notTaker);
    const underwater = await refuses(closeP, (await closeFor(a, CLOSE_TAKER, 60n * WAD, takerA.sk)).inputs, "underwater pair cannot close");
    record("an underwater pair cannot use the taker close; liquidation governs", underwater.ok, underwater);
    const oldMark = await closeFor(a, CLOSE_TAKER, 109n * WAD, takerA.sk);
    const oldMarkResult = await reverts(KEYS.workerB, d.pool, "closePair", closeArgs((await closeP.prove(oldMark.inputs)).proof, oldMark.publicInputs));
    record("a close proved at another price is rejected by the verifier", verifierRejected(oldMarkResult), { oldMarkResult });
    const close = await closeFor(a, CLOSE_TAKER, 110n * WAD, takerA.sk);
    record("taker close fills at the mark less the maker's committed spread", close.outcome.fill === (110n * WAD * 9_970n) / 10_000n && close.outcome.takerOut === 69_940_000n && close.outcome.makerOut === 41_060_000n, close.outcome);
    await send(KEYS.workerB, d.pool, poolAbi, "closePair", closeArgs((await timed("close_pair", () => closeP.prove(close.inputs))).proof, close.publicInputs));
    await processQueue(appendP, d);
    record("taker closes with the maker offline and both are paid", (await restore(ALICE_SEED, d)).some((n) => n.value === 69_940_000n) && (await restore(MAKER_SEED, d)).some((n) => n.value === 41_060_000n));

    const b = await openFor(52n * USD, true, WAD, 100n * WAD, 212n * USD, 110n * WAD);
    const c = await openFor(53n * USD, false, WAD, 111n * WAD, 213n * USD, 110n * WAD);
    const makerB = await keysFor(MAKER_SEED, b.pair.makerX);
    const takerC = await keysFor(ALICE_SEED, c.pair.takerX);
    const exitFor = async (held: { pair: PairRecord; leafIndex: number }, sk: bigint) => exitRequestWitness({ pair: held.pair, leafIndex: held.leafIndex, deployment: d.deploymentId, tree: await chainTree(d), sk });
    const impostor = await refuses(exitP, (await exitFor(b, workerWallets.A.sk)).inputs, "not an owner of this pair");
    record("nobody without an owner key can request an exit, so no one can grief a position", impostor.ok, impostor);
    const BOND = await readPool<bigint>(d.pool, "EXIT_BOND");
    const requestExit = async (held: { pair: PairRecord; leafIndex: number }, sk: bigint): Promise<void> => {
      const w = await exitFor(held, sk);
      const p = await timed("exit_request", () => exitP.prove(w.inputs));
      await send(KEYS.workerB, d.pool, poolAbi, "requestExit", [toHex(p.proof), w.root, w.nullifier], BOND);
    };
    await requestExit(b, makerB.sk);
    await requestExit(c, takerC.sk);
    // Funding settlement must not erase the exit's progress: the request moves to the pair's next version (REC-03, D-11).
    const settleB = async (carryExit: boolean) => updateWitness({
      pair: b.pair, leafIndex: b.leafIndex, deployment: d.deploymentId, tree: await chainTree(d), update: { actor: ACTOR_NONE, add: 0n, remove: 0n, reduce: 0n }, sk: 0n, noteOwner: workerWallets.A,
      mark: 110n * WAD, imrWad: IMR, scale: SCALE, feeBps: 0n, fundingIndex: await fundingIndex(d), riskKeys, feeTo: addressOf(feeWallet), carryExit,
    });
    const nfB = toHex32(recNullifier(pairCommitment(d.deploymentId, b.pair), b.pair.recNonce));
    const dropped = await settleB(false);
    const droppedResult = await reverts(KEYS.workerB, d.pool, "updatePair", updateArgs((await updateP.prove(dropped.inputs)).proof, dropped.publicInputs));
    record("an update cannot silently drop a pending exit", droppedResult?.includes("ExitNotCarried") ?? false, { droppedResult });
    const [, matureBefore] = await readPool<readonly [Address, bigint]>(d.pool, "exitRequests", [nfB]);
    const carrying = await settleB(true);
    await send(KEYS.workerB, d.pool, poolAbi, "updatePair", updateArgs((await updateP.prove(carrying.inputs)).proof, carrying.publicInputs));
    await processQueue(appendP, d);
    const [, matureAfter] = await readPool<readonly [Address, bigint]>(d.pool, "exitRequests", [carrying.publicInputs.carriedNullifier]);
    record("a funding settlement keeps the exit's original deadline", matureAfter === matureBefore && matureAfter !== 0n, { matureAfter });
    const bLive = (await discoverPairs(d, RISK_A_SK, PAIR_CT_RISK_A)).find((x) => x.pair.recNonce === carrying.record.recNonce)!;
    const earlyB = await closeFor(bLive, CLOSE_MATURED, 110n * WAD, 0n);
    const notMature = await reverts(KEYS.workerB, d.pool, "closePair", closeArgs((await closeP.prove(earlyB.inputs)).proof, earlyB.publicInputs));
    record("a forced close before the delay is refused", notMature?.includes("ExitNotMature") ?? false, { notMature });

    await warp(7 * 86_400 + 60);
    await setPrice(d, 90n);
    const forced = await closeFor(bLive, CLOSE_MATURED, 90n * WAD, 0n);
    record("forced exit settles at the mark with no spread", forced.outcome.takerOut === 71_780_000n && forced.outcome.makerOut === 40_220_000n, forced.outcome);
    await send(KEYS.workerB, d.pool, poolAbi, "closePair", closeArgs((await closeP.prove(forced.inputs)).proof, forced.publicInputs));
    await processQueue(appendP, d);
    record("a maker exits a position whose taker has gone away", (await restore(MAKER_SEED, d)).some((n) => n.value === 40_220_000n) && (await restore(ALICE_SEED, d)).some((n) => n.value === 71_780_000n));

    const notDead = await closeFor(c, CLOSE_DEAD_ORACLE, 0n, 0n);
    const notDeadProof = (await closeP.prove(notDead.inputs)).proof;
    const liveOracle = await reverts(KEYS.workerB, d.pool, "closePair", closeArgs(notDeadProof, notDead.publicInputs));
    record("settling at entry is refused while the oracle is alive", liveOracle?.includes("OracleNotDead") ?? false, { liveOracle });
    await warp(15 * 86_400);
    const staleClose = await closeFor(c, CLOSE_MATURED, 90n * WAD, 0n);
    const staleResult = await reverts(KEYS.workerB, d.pool, "closePair", closeArgs((await closeP.prove(staleClose.inputs)).proof, staleClose.publicInputs));
    record("with the oracle down, a forced close at a mark is refused", staleResult?.includes("OracleUnavailable") ?? false, { staleResult });
    const dead = await closeFor(c, CLOSE_DEAD_ORACLE, 0n, 0n);
    record("a dead oracle settles the pair at its entry price, each side keeping its margin", dead.outcome.takerOut === 53n * USD && dead.outcome.makerOut === 60n * USD, dead.outcome);
    await send(KEYS.workerB, d.pool, poolAbi, "closePair", closeArgs((await closeP.prove(dead.inputs)).proof, dead.publicInputs));
    await processQueue(appendP, d);
    const relayer = privateKeyToAccount(KEYS.workerB).address;
    const bonds = await readPool<bigint>(d.pool, "bondBalance", [relayer]);
    await send(KEYS.workerB, d.pool, poolAbi, "withdrawBond", []);
    record("both exit bonds are refundable after their pairs close", bonds === 2n * BOND && (await readPool<bigint>(d.pool, "bondBalance", [relayer])) === 0n, { bonds: bonds.toString() });

    // A market that charges fees: margin changes, partial reduce and keyless funding while the pair stays open (D-14).
    const M2 = 2n;
    const setPrice2 = (usd: bigint) => send(KEYS.deployer, d.otherFeed, feedAbi as Abi, "setAnswer", [usd * 100_000_000n]);
    const epoch2 = async (mark: bigint, by: Hex) => {
      const e = await epoch(mark, M2);
      await send(by, d.pool, poolAbi, "advanceFunding", fundingArgs((await epochP.prove(e.inputs)).proof, e.publicInputs));
      return e;
    };
    await setPrice2(100n);
    await warp(2);
    await epoch2(100n * WAD, KEYS.workerB);
    await fund(KEYS.alice, aliceEoa, ALICE_SEED, alice.owner, 7, [61n * USD, 62n * USD]);
    await fund(KEYS.maker, makerEoa, MAKER_SEED, maker.owner, 6, [221n * USD]);
    await processQueue(appendP, d);
    const expM2 = (await blockTime()) + 86_400n;
    await lockNote("alice", await noteOf(ALICE_SEED, 61n * USD), 61n * USD, takerTerms(M2, false, 2n * WAD, 101n * WAD), expM2, "lock");
    await lockNote("maker", await noteOf(MAKER_SEED, 221n * USD), 221n * USD, makerTerms(M2, 20n, 100n * WAD, 30n), expM2, "lock");
    await processQueue(appendP, d);
    const takerM2 = await findLock(1n, 61n * USD);
    const makerM2 = await findLock(2n, 221n * USD);
    const m2Params = await openParams(100n * WAD, M2);
    const atOi = (limits: Partial<typeof m2Params.limits>) => openPairWitness({ ...m2Params, limits: { ...m2Params.limits, ...limits }, taker: takerM2, maker: makerM2, makerMargin: 60n * USD });
    const overOi = await refuses(openP, atOi({ maxOiUsd: 100n * WAD }).inputs, "open interest limit");
    record("an open past the market's open interest limit cannot be proven", overOi.ok, overOi);
    const overSize = await refuses(openP, atOi({ maxPairSize: WAD }).inputs, "size above market maximum");
    record("an open above the market's size limit cannot be proven", overSize.ok, overSize);
    const wrongLimit = atOi({ maxOiUsd: m2Params.limits.maxOiUsd + 1n });
    const wrongLimitResult = await reverts(KEYS.coordinator, d.pool, "openPair", openArgs((await openP.prove(wrongLimit.inputs)).proof, wrongLimit.publicInputs));
    record("a proof against a different limit than the contract's is rejected by the verifier", verifierRejected(wrongLimitResult), { wrongLimitResult });
    const open5 = atOi({});
    record("the open fee is the fill notional at 10 bps", open5.fee === 200_400n && open5.record.takerMargin === 61n * USD - 200_400n, { fee: open5.fee.toString() });
    await send(KEYS.coordinator, d.pool, poolAbi, "openPair", openArgs((await openP.prove(open5.inputs)).proof, open5.publicInputs));
    await processQueue(appendP, d);

    const liveVersion = async (recNonce: bigint) => {
      const found = (await discoverPairs(d, RISK_A_SK, PAIR_CT_RISK_A)).find((x) => x.pair.recNonce === recNonce);
      if (!found) throw new Error("pair version not found");
      return found;
    };
    const updateFor = async (recNonce: bigint, update: { actor: bigint; add: bigint; remove: bigint; reduce: bigint }, mark: bigint, sk: bigint, noteOwner: WalletKeys, note?: Note) => updateWitness({
      pair: (await liveVersion(recNonce)).pair, leafIndex: (await liveVersion(recNonce)).leafIndex, deployment: d.deploymentId, tree: await chainTree(d), update, sk, noteOwner, note,
      mark, imrWad: IMR, scale: SCALE, feeBps: 10n, fundingIndex: await fundingIndex(d, M2), riskKeys, feeTo: addressOf(feeWallet),
    });
    const applyUpdate = async (w: Awaited<ReturnType<typeof updateFor>>): Promise<bigint> => {
      await send(KEYS.workerB, d.pool, poolAbi, "updatePair", updateArgs((await timed("pair_update", () => updateP.prove(w.inputs))).proof, w.publicInputs));
      await processQueue(appendP, d);
      return w.record.recNonce;
    };
    const none = { actor: ACTOR_TAKER, add: 0n, remove: 0n, reduce: 0n };
    const takerM2Keys = await keysFor(ALICE_SEED, open5.record.takerX);
    let version = open5.record.recNonce;
    const noKey = await refuses(updateP, (await updateFor(version, { ...none, actor: ACTOR_NONE, remove: USD }, 100n * WAD, 0n, workerWallets.A)).inputs, "no key: funding only");
    record("without an owner key an update can only settle funding", noKey.ok, noKey);
    const added = await updateFor(version, { ...none, add: 10n * USD }, 100n * WAD, takerM2Keys.sk, alice, await noteOf(ALICE_SEED, 62n * USD));
    version = await applyUpdate(added);
    record("the taker adds margin from a shielded note and keeps the change", added.record.takerMargin === 70_799_600n && added.outValue === 52n * USD && (await restore(ALICE_SEED, d)).some((n) => n.value === 52n * USD));
    const tooMuch = await refuses(updateP, (await updateFor(version, { ...none, remove: 65n * USD }, 100n * WAD, takerM2Keys.sk, workerWallets.A)).inputs, "below initial margin");
    record("margin cannot be removed below initial margin", tooMuch.ok, tooMuch);
    const removed = await updateFor(version, { ...none, remove: 40n * USD }, 100n * WAD, takerM2Keys.sk, workerWallets.A);
    version = await applyUpdate(removed);
    record("the taker removes margin down to a healthy level", removed.record.takerMargin === 30_799_600n && (await restore(ALICE_SEED, d)).some((n) => n.value === 40n * USD));

    await setPrice2(110n);
    const reduced = await updateFor(version, { ...none, reduce: WAD }, 110n * WAD, takerM2Keys.sk, workerWallets.A);
    record("a partial reduce realizes PnL on the reduced part and pays the fee", reduced.outcome.fee === 109_670n && reduced.record.size === WAD && reduced.record.takerMargin === 40_159_930n && reduced.record.makerMargin === 50_530_000n, reduced.outcome);
    version = await applyUpdate(reduced);

    await warp(2);
    const folded = await epoch2(110n * WAD, KEYS.workerA);
    record("the epoch folds the open, the partial reduce and the zero-size updates to the right open interest", folded.next.longOi === WAD && folded.next.shortOi === 0n, { folded: folded.inputs.count });
    await warp(3700);
    await setPrice2(110n);
    await epoch2(110n * WAD, KEYS.workerA);
    const hour = (MAX_FUNDING / 3600n * 3600n * (110n * WAD)) / WAD;
    const owedHour = (WAD * hour - 1n) / (WAD * SCALE) + 1n;
    const settledFunding = await updateFor(version, { ...none, actor: ACTOR_NONE }, 110n * WAD, 0n, workerWallets.A);
    record("a worker with no owner key settles funding on an open pair", settledFunding.outcome.fundingOwed === owedHour && settledFunding.record.takerMargin === 40_159_930n - owedHour && settledFunding.record.makerMargin === 50_530_000n + owedHour && settledFunding.record.fundingIndex === (await fundingIndex(d, M2)), settledFunding.outcome);
    version = await applyUpdate(settledFunding);

    const finalM2 = await liveVersion(version);
    const closedM2 = await closeFor(finalM2, CLOSE_TAKER, 110n * WAD, takerM2Keys.sk);
    record("no funding is charged twice, and the close pays the fee", closedM2.outcome.fundingOwed === 0n && closedM2.outcome.fee === 109_670n && closedM2.outcome.takerOut === 40_159_930n - owedHour + 9_470_000n - 109_670n, closedM2.outcome);
    await send(KEYS.workerB, d.pool, poolAbi, "closePair", closeArgs((await closeP.prove(closedM2.inputs)).proof, closedM2.publicInputs));
    await processQueue(appendP, d);
    const feeNotes = await restore(FEE_SEED, d);
    record("fees reach the fee address as shielded notes", sum(feeNotes) === 200_400n + 109_670n + 109_670n, { fees: sum(feeNotes).toString() });

    // Anyone can create a market: a creator bond sits behind insurance, and comes back once the market is closed and empty (D-22).
    const creator = privateKeyToAccount(KEYS.deployer).address;
    await send(KEYS.deployer, d.asset, erc20 as Abi, "mintTo", [creator, 30n * USD]);
    await send(KEYS.deployer, d.asset, erc20 as Abi, "approve", [d.markets, 30n * USD]);
    await send(KEYS.deployer, d.thirdFeed, feedAbi as Abi, "setAnswer", [100n * 100_000_000n]);
    await send(KEYS.deployer, d.markets, marketsAbi, "createMarket", [0n, d.thirdFeedId, 1_000_000n * WAD, 20n * USD]);
    const M3 = await pub.readContract({ address: d.markets, abi: marketsAbi, functionName: "FIRST_MARKET_ID" }) as bigint;
    record("a market is created by anyone, with its bond in custody", (await readPool<bigint>(d.pool, "marketBond", [M3])) === 20n * USD);
    const setPrice3 = (usd: bigint) => send(KEYS.deployer, d.thirdFeed, feedAbi as Abi, "setAnswer", [usd * 100_000_000n]);
    await fund(KEYS.alice, aliceEoa, ALICE_SEED, alice.owner, 9, [12n * USD]);
    await fund(KEYS.maker, makerEoa, MAKER_SEED, maker.owner, 7, [231n * USD]);
    await processQueue(appendP, d);
    const expM3 = (await blockTime()) + 86_400n;
    await lockNote("alice", await noteOf(ALICE_SEED, 12n * USD), 12n * USD, takerTerms(M3, false, WAD, 101n * WAD), expM3, "lock");
    await lockNote("maker", await noteOf(MAKER_SEED, 231n * USD), 231n * USD, makerTerms(M3, 20n, 100n * WAD, 30n), expM3, "lock");
    await processQueue(appendP, d);
    const open3M = openPairWitness({ ...(await openParams(100n * WAD, M3)), taker: await findLock(1n, 12n * USD), maker: await findLock(2n, 231n * USD), makerMargin: 12n * USD });
    await send(KEYS.coordinator, d.pool, poolAbi, "openPair", openArgs((await openP.prove(open3M.inputs)).proof, open3M.publicInputs));
    await processQueue(appendP, d);
    await setPrice3(70n);
    const held3 = (await discoverPairs(d, RISK_A_SK, PAIR_CT_RISK_A)).find((x) => x.pair.recNonce === open3M.record.recNonce)!;
    const w3M = liquidateWitness({ pair: held3.pair, leafIndex: held3.leafIndex, deployment: d.deploymentId, tree: await chainTree(d), mark: 70n * WAD, mmrWad: MMR, penaltyBps: PENALTY_BPS, scale: SCALE, riskKeys, fundingIndex: await fundingIndex(d, M3), liquidator: addressOf(workerWallets.A) });
    const expectedClaim = 30_200_000n - 12n * USD;
    record("a loss past margin in the new market becomes a claim for the winner", w3M.outcome.claim === expectedClaim && w3M.outcome.takerOut === 0n, w3M.outcome);
    await send(KEYS.workerA, d.pool, poolAbi, "liquidate", liqArgs((await liqP.prove(w3M.inputs)).proof, w3M.publicInputs));
    await processQueue(appendP, d);
    await warp(2);
    await setPrice3(70n);
    const fold3 = await (async () => {
      const [st, asOf] = await Promise.all([readPool<{ lastEpoch: bigint; head: Hex }>(d.pool, "funding", [M3]), blockTime()]);
      const elapsed = asOf - st.lastEpoch;
      return fundingEpochWitness({
        deployment: d.deploymentId, market: M3, state: await marketFromChain(d, RISK_A_SK, MARKET_CT_RISK_A, M3), head: BigInt(st.head),
        deltas: await pendingDeltas(d, RISK_A_SK, PAIR_CT_RISK_A, M3), asOf, dt: elapsed > 3600n ? 3600n : elapsed, mark: 70n * WAD, maxRateWad: MAX_FUNDING, keys: [coordinator, riskA, riskB], bondTotal: 20n * USD,
      });
    })();
    record("with no insurance yet, the creator's bond pays the claim in full", fold3.publicInputs.claimRatio === WAD && fold3.next.bondUsed === expectedClaim && fold3.next.badDebt === 0n, { bondUsed: fold3.next.bondUsed });
    await send(KEYS.workerA, d.pool, poolAbi, "advanceFunding", fundingArgs((await epochP.prove(fold3.inputs)).proof, fold3.publicInputs));
    const claim3 = (await chainClaims(d, RISK_A_SK, 1)).find((x) => x.claim.market === M3)!;
    const redeem3 = redeemWitness({ claim: claim3.claim, leafIndex: claim3.leafIndex, deployment: d.deploymentId, tree: await chainTree(d), ratio: WAD });
    await send(KEYS.workerB, d.markets, marketsAbi, "redeemClaim", redeemArgs((await redeemP.prove(redeem3.inputs)).proof, redeem3.publicInputs));
    await processQueue(appendP, d);
    record("the winner is paid from the bond as a private note", (await restore(MAKER_SEED, d)).some((n) => n.value === expectedClaim));

    const earlyClose = await reverts(KEYS.deployer, d.markets, "releaseBond", ["0x", M3, 0n]);
    record("the bond stays locked while the market is open", earlyClose?.includes("MarketStillOpen") ?? false, { earlyClose });
    const notCreator = await reverts(KEYS.workerA, d.markets, "closeToNewPositions", [M3]);
    record("only the creator can close the market", notCreator?.includes("NotCreator") ?? false, { notCreator });
    await send(KEYS.deployer, d.markets, marketsAbi, "closeToNewPositions", [M3]);
    const stateM3 = await marketFromChain(d, RISK_A_SK, MARKET_CT_RISK_A, M3);
    const headM3 = BigInt((await readPool<{ head: Hex }>(d.pool, "funding", [M3])).head);
    const release = bondReleaseWitness({ deployment: d.deploymentId, market: M3, state: stateM3, head: headM3 });
    const releaseP = await load("bond_release");
    const releaseProof = await releaseP.prove(release.inputs);
    const lied = await reverts(KEYS.workerA, d.markets, "releaseBond", [toHex(releaseProof.proof), M3, release.bondUsed - 1n]);
    record("the creator cannot claim less of the bond was used", verifierRejected(lied), { lied });
    const creatorBefore = (await pub.readContract({ address: d.asset, abi: erc20, functionName: "balanceOf", args: [creator] })) as bigint;
    await send(KEYS.workerA, d.markets, marketsAbi, "releaseBond", [toHex(releaseProof.proof), M3, release.bondUsed]);
    await releaseP.destroy();
    const creatorAfter = (await pub.readContract({ address: d.asset, abi: erc20, functionName: "balanceOf", args: [creator] })) as bigint;
    record("the unused bond returns to the creator, and only the unused part", creatorAfter - creatorBefore === 20n * USD - expectedClaim, { returned: creatorAfter - creatorBefore });

    // Fold everything so private market state is complete, then reconcile every token.
    const foldAll = async (market: bigint, mark: bigint, reprice: () => Promise<unknown>): Promise<void> => {
      for (;;) {
        const [count, st] = await Promise.all([readPool<bigint>(d.pool, "oiDeltaCount", [market]), readPool<{ consumed: bigint }>(d.pool, "funding", [market])]);
        if (st.consumed >= count) return;
        await warp(2);
        await reprice();
        const e = await epoch(mark, market);
        await send(KEYS.workerA, d.pool, poolAbi, "advanceFunding", fundingArgs((await epochP.prove(e.inputs)).proof, e.publicInputs));
      }
    };
    await foldAll(d.market, 100n * WAD, () => setPrice(d, 100n));
    await foldAll(M2, 110n * WAD, () => setPrice2(110n));

    const reconcile = async () => {
      const [aliceN, makerN, workerN, feeN] = await Promise.all([
        restore(ALICE_SEED, d), restore(MAKER_SEED, d), Promise.all([restore(WORKER_A_SEED, d), restore(WORKER_B_SEED, d)]).then((x) => x.flat()), restore(FEE_SEED, d),
      ]);
      let lockedLive = 0n;
      for (const h of await openLocks(d, COORDINATOR_SK)) {
        const nf = recNullifier(lockCommitment(d.deploymentId, h.record), h.record.recNonce);
        if (!(await readPool<boolean>(d.pool, "nullifierSpent", [toHex32(nf)]))) lockedLive += h.record.amount;
      }
      const [m1, m2] = await Promise.all([marketFromChain(d, RISK_A_SK, MARKET_CT_RISK_A), marketFromChain(d, RISK_A_SK, MARKET_CT_RISK_A, M2)]);
      const custody = (await pub.readContract({ address: d.asset, abi: erc20, functionName: "balanceOf", args: [d.pool] })) as bigint;
      const notes = sum(aliceN) + sum(makerN) + sum(workerN) + sum(feeN);
      return { custody, notes, lockedLive, insurance: m1.insurance + m2.insurance, m1, feeN };
    };
    const before = await reconcile();
    record("custody equals live notes + open locks + private insurance, with all positions closed",
      before.custody === before.notes + before.lockedLive + before.insurance && before.m1.longOi === 0n && before.m1.shortOi === 0n, {
        custody: before.custody.toString(), notes: before.notes.toString(), lockedLive: before.lockedLive.toString(), insurance: before.insurance.toString(),
      });

    // A market that has ended releases its remaining insurance to the fee address (D-17).
    const sweepFor = async (state: MarketState) => insuranceSweepWitness({
      deployment: d.deploymentId, market: d.market, asset: BigInt(d.asset), state, head: BigInt((await readPool<{ head: Hex }>(d.pool, "funding", [d.market])).head), feeTo: addressOf(feeWallet), keys: [coordinator, riskA, riskB],
    });
    const earlySweep = await sweepFor(before.m1);
    const earlyProof = await sweepP.prove(earlySweep.inputs);
    const tooEarly = await reverts(KEYS.workerA, d.markets, "sweepInsurance", sweepArgs(earlyProof.proof, earlySweep.publicInputs));
    record("insurance cannot be swept while the market's oracle is alive", tooEarly?.includes("MarketNotWoundDown") ?? false, { tooEarly });
    const wrongState = await refuses(sweepP, (await sweepFor({ ...before.m1, insurance: before.m1.insurance + 1n })).inputs, "open positions or wrong record");
    record("a sweep cannot claim a different insurance balance", wrongState.ok, wrongState);
    await warp(91 * 86_400);
    const sweep = await sweepFor(before.m1);
    await send(KEYS.workerA, d.markets, marketsAbi, "sweepInsurance", sweepArgs((await timed("insurance_sweep", () => sweepP.prove(sweep.inputs))).proof, sweep.publicInputs));
    await processQueue(appendP, d);
    const after = await reconcile();
    record("after 90 days dead, the insurance moves to the fee address and custody still balances",
      after.m1.insurance === 0n && after.custody === before.custody && after.custody === after.notes + after.lockedLive + after.insurance && sum(after.feeN) === sum(before.feeN) + before.m1.insurance,
      { swept: before.m1.insurance.toString() });

    // Key rotation (REC-07, D-24). The operator replaces every key while positions under the old keys stay live; nothing stops.
    const keyEpoch = (): Promise<bigint> => pub.readContract({ address: d.markets, abi: marketsAbi, functionName: "keyEpoch" }) as Promise<bigint>;
    await setPrice(d, 100n);
    await warp(2);
    const freshEpoch = await epoch(100n * WAD);
    await send(KEYS.workerA, d.pool, poolAbi, "advanceFunding", fundingArgs((await epochP.prove(freshEpoch.inputs)).proof, freshEpoch.publicInputs));
    await fund(KEYS.alice, aliceEoa, ALICE_SEED, alice.owner, 10, [71n * USD, 72n * USD, 73n * USD, 74n * USD, 75n * USD]);
    await fund(KEYS.maker, makerEoa, MAKER_SEED, maker.owner, 8, [241n * USD, 242n * USD, 243n * USD, 245n * USD]);
    await processQueue(appendP, d);
    const oldLiq = await openFor(71n * USD, false, 2n * WAD, 101n * WAD, 241n * USD, 100n * WAD);
    const oldMig = await openFor(72n * USD, false, WAD, 101n * WAD, 242n * USD, 100n * WAD);
    record("two positions open under the original keys", oldLiq.pair.size === 2n * WAD && oldMig.pair.size === WAD);

    const point = (sk: bigint) => mulGenerator(sk);
    const nextKeys = { coordinator: point(NEW_COORDINATOR_SK), riskA: point(NEW_RISK_A_SK), riskB: point(NEW_RISK_B_SK) };
    const notGuardian = await reverts(KEYS.alice, d.markets, "scheduleKeyRotation", [nextKeys]);
    record("only the key guardian can schedule a rotation", notGuardian?.includes("NotKeyGuardian") ?? false, { notGuardian });
    const offCurveKeys = { ...nextKeys, riskA: { x: 1n, y: 1n } };
    const offCurve = await reverts(KEYS.deployer, d.markets, "scheduleKeyRotation", [offCurveKeys]);
    record("a key that is not a curve point is refused before it can break liquidation", offCurve?.includes("KeyNotOnCurve") ?? false, { offCurve });

    await send(KEYS.deployer, d.markets, marketsAbi, "scheduleKeyRotation", [nextKeys]);
    const earlyActivate = await reverts(KEYS.workerB, d.markets, "activateKeyRotation", []);
    record("a rotation cannot take effect before its delay", earlyActivate?.includes("KeyRotationNotDue") ?? false, { earlyActivate });
    const [activatesAt] = await pub.readContract({ address: d.markets, abi: marketsAbi, functionName: "pendingKeyRotation" }) as readonly [bigint, unknown];
    const delaySeconds = await pub.readContract({ address: d.markets, abi: marketsAbi, functionName: "KEY_ROTATION_DELAY" }) as bigint;
    const scheduledAt = await blockTime();
    record("the schedule is public, delayed, and leaves the live keys unchanged", activatesAt === scheduledAt + delaySeconds && (await readPool<bigint>(d.pool, "riskAX")) === riskA.x, { activatesAt: activatesAt.toString() });

    // A lock made during the delay still uses the current keys and lands. It stays open across the change.
    const parkedTaker = await noteOf(ALICE_SEED, 73n * USD);
    await lockNote("alice", parkedTaker, 73n * USD, takerTerms(d.market, false, WAD, 101n * WAD), (await blockTime()) + 30n * 86_400n, "lock");
    const parkedMakerNote = await noteOf(MAKER_SEED, 243n * USD);
    await lockNote("maker", parkedMakerNote, 243n * USD, makerTerms(d.market, 20n, 100n * WAD, 30n), (await blockTime()) + 30n * 86_400n, "lock");
    await processQueue(appendP, d);
    record("during the delay a new lock still uses the current keys and lands", true);

    await warp(Number(delaySeconds) + 1);
    await send(KEYS.workerB, d.markets, marketsAbi, "activateKeyRotation", []);
    const liveRisk = await readPool<bigint>(d.pool, "riskAX");
    record("anyone activates after the delay and the new keys are in effect", liveRisk === nextKeys.riskA.x && (await readPool<bigint>(d.pool, "coordinatorX")) === nextKeys.coordinator.x && (await keyEpoch()) === 1n, { epoch: (await keyEpoch()).toString() });
    const retired = await reverts(KEYS.deployer, d.markets, "scheduleKeyRotation", [{ ...nextKeys, riskA: mulGenerator(RISK_A_SK) }]);
    record("a retired key can never be scheduled again", retired?.includes("KeyReused") ?? false, { retired });

    const retiredLockNote = await noteOf(ALICE_SEED, 74n * USD);
    const retiredLockW = lockWitness({ keys: retiredLockNote.keys, deployment: d.deploymentId, tree: await chainTree(d), asset: BigInt(d.asset), inputs: [retiredLockNote], amount: 74n * USD, terms: takerTerms(d.market, false, WAD, 101n * WAD), expiry: (await blockTime()) + 86_400n, coordinator, riskKeys, payout: payoutFor("alice"), view: alice.pk });
    const retiredLock = await reverts(KEYS.workerB, d.pool, "lock", lockArgs((await lockP.prove(retiredLockW.inputs)).proof, retiredLockW.publicInputs));
    record("a lock encrypted to a retired key is rejected by the verifier after the transition", verifierRejected(retiredLock), { retiredLock });

    // From here the operator holds both sets: new work uses the new keys, old records stay readable.
    coordinator = nextKeys.coordinator;
    riskA = nextKeys.riskA;
    riskB = nextKeys.riskB;
    riskKeys = [riskA, riskB];
    HELD.coordinator = [NEW_COORDINATOR_SK, COORDINATOR_SK];
    HELD.riskA = [NEW_RISK_A_SK, RISK_A_SK];

    await setPrice(d, 100n);
    await warp(2);
    await setPrice(d, 100n);
    const carryForward = await epoch(100n * WAD);
    await send(KEYS.workerA, d.pool, poolAbi, "advanceFunding", fundingArgs((await epochP.prove(carryForward.inputs)).proof, carryForward.publicInputs));
    record("the first epoch after rotation folds records opened under the old keys and moves market state to the new keys",
      carryForward.next.longOi === 3n * WAD && (await marketOpens(d, NEW_RISK_A_SK, MARKET_CT_RISK_A)) && !(await marketOpens(d, RISK_A_SK, MARKET_CT_RISK_A)), { longOi: carryForward.next.longOi.toString() });

    const newLockNote = await noteOf(ALICE_SEED, 75n * USD);
    await lockNote("alice", newLockNote, 75n * USD, takerTerms(d.market, false, WAD, 101n * WAD), (await blockTime()) + 86_400n, "lock");
    const newMakerNote = await noteOf(MAKER_SEED, 245n * USD);
    await lockNote("maker", newMakerNote, 245n * USD, makerTerms(d.market, 20n, 100n * WAD, 30n), (await blockTime()) + 86_400n, "lock");
    await processQueue(appendP, d);
    const newLockByOldKey = await openLocks(d, COORDINATOR_SK);
    record("a new lock under the new keys is not readable with the retired coordinator key", !newLockByOldKey.some((h) => h.record.amount === 75n * USD));
    const openNew = openPairWitness({ ...(await openParams(100n * WAD)), taker: await findLock(1n, 75n * USD), maker: await findLock(2n, 245n * USD), makerMargin: 60n * USD });
    await send(KEYS.coordinator, d.pool, poolAbi, "openPair", openArgs((await openP.prove(openNew.inputs)).proof, openNew.publicInputs));
    await processQueue(appendP, d);
    const newRead = await discoverPairs(d, NEW_RISK_A_SK, PAIR_CT_RISK_A);
    const oldRead = await discoverPairs(d, RISK_A_SK, PAIR_CT_RISK_A);
    record("a position opened after rotation is readable with the new risk key and not with the retired one",
      newRead.some((x) => x.pair.recNonce === openNew.record.recNonce) && !oldRead.some((x) => x.pair.recNonce === openNew.record.recNonce));

    const parkedOpen = openPairWitness({ ...(await openParams(100n * WAD)), taker: await findLock(1n, 73n * USD), maker: await findLock(2n, 243n * USD), makerMargin: 60n * USD });
    await send(KEYS.coordinator, d.pool, poolAbi, "openPair", openArgs((await openP.prove(parkedOpen.inputs)).proof, parkedOpen.publicInputs));
    await processQueue(appendP, d);
    record("a lock made under the retired coordinator key is still matched by the holder of that key, into a position under the new risk keys",
      (await discoverPairs(d, NEW_RISK_A_SK, PAIR_CT_RISK_A)).some((x) => x.pair.recNonce === parkedOpen.record.recNonce) && parkedOpen.record.size === WAD);

    // Liquidation of a position under the old keys, by a worker that still holds the old key.
    await setPrice(d, 65n);
    const heldOld = (await discoverPairs(d, RISK_A_SK, PAIR_CT_RISK_A)).find((x) => x.pair.recNonce === oldLiq.pair.recNonce);
    const heldNew = (await discoverPairs(d, NEW_RISK_A_SK, PAIR_CT_RISK_A)).find((x) => x.pair.recNonce === oldLiq.pair.recNonce);
    record("a position opened under old keys is readable with the retired key and not with the new one", heldOld !== undefined && heldNew === undefined);
    const liqOld = await liq(heldOld!.pair, heldOld!.leafIndex, 65n * WAD, workerWallets.A);
    record("the reference model says the old position is liquidatable at 65", liqOld.outcome.takerBad, liqOld.outcome);
    const wrongKeyLiq = await reverts(KEYS.workerA, d.pool, "liquidate", liqArgs((await liqP.prove(liquidateWitness({ pair: heldOld!.pair, leafIndex: heldOld!.leafIndex, deployment: d.deploymentId, tree: await chainTree(d), mark: 65n * WAD, mmrWad: MMR, penaltyBps: PENALTY_BPS, scale: SCALE, riskKeys: [mulGenerator(RISK_A_SK), mulGenerator(RISK_B_SK)], fundingIndex: await fundingIndex(d), liquidator: addressOf(workerWallets.A) }).inputs)).proof, liqOld.publicInputs));
    record("a liquidation that claims the retired risk keys for its claim ciphertext is rejected by the verifier", verifierRejected(wrongKeyLiq), { wrongKeyLiq });
    const workerBefore = sum(await restore(WORKER_A_SEED, d));
    await send(KEYS.workerA, d.pool, poolAbi, "liquidate", liqArgs((await liqP.prove(liqOld.inputs)).proof, liqOld.publicInputs));
    await processQueue(appendP, d);
    record("the worker holding the retired key liquidates the old position; the reward arrives privately", sum(await restore(WORKER_A_SEED, d)) === workerBefore + liqOld.outcome.reward, { reward: liqOld.outcome.reward.toString() });
    record("the claim from that liquidation is readable with the new risk key", (await chainClaims(d, NEW_RISK_A_SK, 1)).some((x) => x.claim.pairNonce === heldOld!.pair.recNonce));

    // The other old position moves forward with a keyless update, so it no longer depends on the retired key.
    const heldMig = (await discoverPairs(d, RISK_A_SK, PAIR_CT_RISK_A)).find((x) => x.pair.recNonce === oldMig.pair.recNonce)!;
    const migrate = updateWitness({ pair: heldMig.pair, leafIndex: heldMig.leafIndex, deployment: d.deploymentId, tree: await chainTree(d), update: { actor: ACTOR_NONE, add: 0n, remove: 0n, reduce: 0n }, sk: 0n, noteOwner: workerWallets.A,
      mark: 65n * WAD, imrWad: IMR, scale: SCALE, feeBps: 0n, fundingIndex: await fundingIndex(d), riskKeys, feeTo: addressOf(feeWallet) });
    await send(KEYS.workerB, d.pool, poolAbi, "updatePair", updateArgs((await updateP.prove(migrate.inputs)).proof, migrate.publicInputs));
    await processQueue(appendP, d);
    const migratedNew = (await discoverPairs(d, NEW_RISK_A_SK, PAIR_CT_RISK_A)).find((x) => x.pair.recNonce === migrate.record.recNonce);
    const migratedOld = (await discoverPairs(d, RISK_A_SK, PAIR_CT_RISK_A)).find((x) => x.pair.recNonce === migrate.record.recNonce);
    record("a keyless update moves an old position forward: the new key reads it, the retired key no longer does, and its value is unchanged",
      migratedNew !== undefined && migratedOld === undefined && migrate.record.size === WAD && migrate.record.takerMargin + migrate.record.makerMargin === heldMig.pair.takerMargin + heldMig.pair.makerMargin,
      { takerMargin: migrate.record.takerMargin.toString(), makerMargin: migrate.record.makerMargin.toString() });
  } finally {
    await Promise.all([appendP, lockP, openP, liqP, relP, epochP, closeP, exitP, updateP, redeemP, sweepP].map((p) => p.destroy()));
  }

  writeFileSync(`${ROOT}docs/privacy/evidence/w2-offline-liquidation-local.json`, JSON.stringify({
    note: "Local anvil (31337). Perp lifecycle candidate: no spot or LP. Synthetic identities.",
    steps, gas, proveMs,
  }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`${steps.length} steps passed`, gas, proveMs);
}

await main();
