/**
 * W1 end-to-end: shield, permissionless queue processing, private transfer, scan, unshield through a relayer,
 * adversarial rejections, restore from seed, custody reconciliation, and an observer log of what is public.
 * Real UltraHonk proofs from the wallet SDK, verified by the generated Solidity verifiers on anvil.
 *
 *   anvil --port 8547 &   (a dedicated chain, not the main local stack)
 *   RPC=http://127.0.0.1:8547 bun run private/shielded-flow.ts
 *
 * Writes docs/privacy/evidence/w1-shielded-flow-local.json. Uses anvil's public test keys only.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, decodeEventLog, http, parseAbi, type Abi, type Address, type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  addressOf, appendWitness, APPEND_BATCH, depositOpening, deriveKeys, initCrypto, leafOf, MerkleTree, noteCommitment,
  noteInner, ownerNullifier, Prover,
  scanCreated, scanDeposits, spendWitness, toHex32, type CompiledCircuit, type CreatedNotes, type OwnedNote, type ShieldedDeposit,
  type SpendPublic, type WalletKeys,
} from "@rooq/private-sdk";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RPC = process.env.RPC ?? "http://127.0.0.1:8547";
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  alice: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  bob: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  relayer: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const;
const ALICE_SEED = 0xa11ce5eedn;
const BOB_SEED = 0xb0b5eedn;
const RELAYER_SEED = 0x7e1a5eedn;

const read = (p: string): string => readFileSync(`${ROOT}${p}`, "utf8");
const artifact = (name: string): Abi => (JSON.parse(read(`contracts/out/${name}.sol/${name}.json`)) as { abi: Abi }).abi;
const circuit = (name: string): CompiledCircuit => JSON.parse(read(`zk/circuits/target/${name}.json`)) as CompiledCircuit;
const poolAbi = artifact("ShieldedPool");
const erc20 = parseAbi([
  "function mintTo(address,uint256)", "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

const steps: { step: string; ok: boolean; detail: unknown }[] = [];
const observer: { tx: string; action: string; visible: unknown }[] = [];
function record(step: string, ok: boolean, detail: unknown): void {
  steps.push({ step, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${step}`);
  if (!ok) throw new Error(`${step}: ${JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}

const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: foundry, transport: http(RPC) });

async function send(k: Hex, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
  const hash = await wallet(k).writeContract({ address, abi, functionName, args, chain: foundry });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

/** UltraHonk verifier errors (selectors from contracts/src/privacy/verifiers/SpendVerifier.sol). */
const VERIFIER_ERRORS: Record<string, string> = {
  "0x9fc3a218": "SumcheckFailed", "0xa5d82e8a": "ShpleminiFailed", "0xa2a2ac83": "ConsistencyCheckFailed",
  "0xeb73e0bd": "ValueGeLimbMax", "0x20a33589": "ValueGeFieldOrder", "0x607be13e": "ValueGeGroupOrder",
  "0xfa066593": "PublicInputsLengthWrong", "0xed74ac0a": "ProofLengthWrong", "0x4ddaa5e5": "PointAtInfinity",
};

/** Simulates a call; returns null on success or the revert's error name (verifier errors decoded by selector). */
async function reverts(k: Hex, address: Address, functionName: string, args: readonly unknown[]): Promise<string | null> {
  try {
    await pub.simulateContract({ account: privateKeyToAccount(k), address, abi: poolAbi, functionName, args });
    return null;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    const named = /reverted with the following reason:\s*\n?(.*)|Error: (\w+\(.*?\))/.exec(m)?.slice(1).find(Boolean);
    if (named) return named;
    const sig = /following signature:\s*\n?\s*(0x[0-9a-f]{8})/i.exec(m)?.[1]?.toLowerCase();
    if (sig) return `verifier:${VERIFIER_ERRORS[sig] ?? sig}`;
    return m.split("\n")[0]!;
  }
}

/** Every topic and data word of a receipt's logs, for searching what an observer can see. */
function logText(r: TransactionReceipt): string {
  return r.logs.map((l) => [...l.topics, l.data].join("")).join("").toLowerCase();
}

/** A revert raised by the verifier, not by a pool precondition that would make the check meaningless. */
function verifierRejected(reason: string | null): boolean {
  return (reason?.startsWith("verifier:") ?? false) && !/PublicInputsLengthWrong|ProofLengthWrong/.test(reason ?? "");
}

function logs(r: TransactionReceipt): { eventName: string; args: Record<string, unknown> }[] {
  return r.logs.flatMap((l) => {
    try {
      const d = decodeEventLog({ abi: poolAbi, data: l.data, topics: l.topics });
      return [{ eventName: String(d.eventName), args: d.args as unknown as Record<string, unknown> }];
    } catch {
      return [];
    }
  });
}

function deploy(out: string): { pool: Address; asset: Address; deploymentId: bigint; spendVerifier: Address } {
  execFileSync("forge", ["script", "script/DeployPrivacy.s.sol", "--rpc-url", RPC, "--broadcast", "--silent"], {
    cwd: `${ROOT}contracts`,
    env: { ...process.env, DEPLOYER_PRIVATE_KEY: KEYS.deployer, PRIVACY_OUT: out },
    stdio: "pipe",
  });
  const d = JSON.parse(readFileSync(out, "utf8")) as { shieldedPool: Address; assets: Address[]; deploymentId: number | string; spendVerifier: Address };
  return { pool: d.shieldedPool, asset: d.assets[0]!, deploymentId: BigInt(d.deploymentId), spendVerifier: d.spendVerifier };
}

/** Rebuilds the tree from on-chain queue entries already processed. This is what any party can do. */
async function chainTree(pool: Address, deploymentId: bigint): Promise<MerkleTree> {
  const tree = new MerkleTree();
  const processed = (await pub.readContract({ address: pool, abi: poolAbi, functionName: "processed" })) as bigint;
  const entries = await queue(pool, 0n, processed);
  for (const e of entries) tree.insert(leafOf(e, deploymentId));
  return tree;
}

async function queue(pool: Address, from: bigint, to: bigint) {
  const out = [];
  for (let i = from; i < to; i++) {
    const e = (await pub.readContract({ address: pool, abi: poolAbi, functionName: "queueEntry", args: [i] })) as { kind: number; a: Hex; b: Hex; c: Hex };
    out.push({ kind: BigInt(e.kind), a: BigInt(e.a), b: BigInt(e.b), c: BigInt(e.c) });
  }
  return out;
}

async function processQueue(appendProver: Prover, pool: Address, deploymentId: bigint, by: Hex): Promise<void> {
  for (;;) {
    const [len, done] = (await Promise.all([
      pub.readContract({ address: pool, abi: poolAbi, functionName: "queueLength" }),
      pub.readContract({ address: pool, abi: poolAbi, functionName: "processed" }),
    ])) as [bigint, bigint];
    if (done >= len) return;
    const end = done + BigInt(Math.min(APPEND_BATCH, Number(len - done)));
    const tree = await chainTree(pool, deploymentId);
    const { inputs, newRoot } = appendWitness(tree, await queue(pool, done, end), deploymentId);
    const t0 = performance.now();
    const p = await appendProver.prove(inputs);
    const ms = Math.round(performance.now() - t0);
    const r = await send(by, pool, poolAbi, "processQueue", [toHex(p.proof), toHex32(newRoot)]);
    observer.push({ tx: r.transactionHash, action: "processQueue", visible: { leaves: Number(end - done), newRoot: toHex32(newRoot), gasUsed: r.gasUsed.toString(), proveMs: ms } });
  }
}

const toHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;
const spendArgs = (proof: Uint8Array, p: SpendPublic) => [toHex(proof), {
  root: p.root, nullifiers: p.nullifiers, commitments: p.commitments, ciphertexts: p.ciphertexts,
  publicAsset: p.publicAsset, withdrawAmount: p.withdrawAmount, withdrawRecipient: p.withdrawRecipient,
  relayer: p.relayer, relayerFee: p.relayerFee,
}] as const;

async function events(pool: Address) {
  const all = await pub.getContractEvents({ address: pool, abi: poolAbi, fromBlock: 0n });
  const created: CreatedNotes[] = [];
  const deposits: ShieldedDeposit[] = [];
  for (const l of all) {
    const a = l.args as Record<string, unknown>;
    if (l.eventName === "NotesCreated") {
      created.push({
        firstLeafIndex: Number(a.firstLeafIndex as bigint),
        commitments: (a.commitments as Hex[]).map(BigInt),
        ciphertexts: (a.ciphertexts as Hex[][]).map((c) => c.map(BigInt)),
      });
    } else if (l.eventName === "Shielded") {
      deposits.push({ leafIndex: Number(a.leafIndex as bigint), asset: BigInt(a.asset as Address), amount: a.amount as bigint, inner: BigInt(a.inner as Hex) });
    }
  }
  return { created, deposits };
}

/** A wallet's spendable notes, rebuilt only from its seed and public chain data. */
async function restore(seed: bigint, keys: WalletKeys, pool: Address, deploymentId: bigint): Promise<OwnedNote[]> {
  const { created, deposits } = await events(pool);
  const processed = Number((await pub.readContract({ address: pool, abi: poolAbi, functionName: "processed" })) as bigint);
  const mine = [...scanDeposits(seed, keys, deploymentId, deposits), ...scanCreated(keys, deploymentId, created)];
  const live: OwnedNote[] = [];
  for (const n of mine) {
    const spent = (await pub.readContract({ address: pool, abi: poolAbi, functionName: "nullifierSpent", args: [toHex32(n.nullifier)] })) as boolean;
    if (!spent && n.leafIndex < processed && n.value > 0n) live.push(n);
  }
  return live.sort((x, y) => x.leafIndex - y.leafIndex);
}

const sum = (ns: readonly OwnedNote[]): bigint => ns.reduce((s, n) => s + n.value, 0n);

async function main(): Promise<void> {
  await initCrypto();
  const chainId = await pub.getChainId();
  record("dedicated local chain", chainId === 31337, { rpc: RPC, chainId });
  const outDir = `${ROOT}docs/privacy/evidence`;
  mkdirSync(outDir, { recursive: true });
  const { pool, asset, deploymentId, spendVerifier } = deploy(`${ROOT}contracts/deployments/privacy-e2e.json`);
  record("deploy ShieldedPool and verifiers (incomplete W1 fixture)", true, { pool, asset, deploymentId: deploymentId.toString(), spendVerifier });

  const appendProver = await Prover.create(circuit("append"));
  const spendProver = await Prover.create(circuit("spend"));
  try {
    const alice = deriveKeys(ALICE_SEED);
    const bob = deriveKeys(BOB_SEED);
    const aliceEoa = privateKeyToAccount(KEYS.alice).address;
    const bobEoa = privateKeyToAccount(KEYS.bob).address;
    const relayerEoa = privateKeyToAccount(KEYS.relayer).address;

    // 1. Alice shields 600 and 400 tUSDG with seed-derived openings.
    await send(KEYS.deployer, asset, erc20 as Abi, "mintTo", [aliceEoa, 1_000_000_000n]);
    await send(KEYS.alice, asset, erc20 as Abi, "approve", [pool, 1_000_000_000n]);
    for (const [k, amount] of [[0, 600_000_000n], [1, 400_000_000n]] as const) {
      const { rho, blind } = depositOpening(ALICE_SEED, k);
      const r = await send(KEYS.alice, pool, poolAbi, "shield", [asset, amount, toHex32(noteInner(alice.owner, rho, blind))]);
      observer.push({ tx: r.transactionHash, action: "shield", visible: { from: aliceEoa, asset, amount: amount.toString(), inner: "random-looking field element", events: logs(r).map((l) => l.eventName) } });
    }
    record("alice shields 600 + 400 (public boundary: sender, asset, amount)", true, {});

    // 2. A third party processes the queue; no secret is needed.
    await processQueue(appendProver, pool, deploymentId, KEYS.relayer);
    const tree1 = await chainTree(pool, deploymentId);
    const onchainRoot = (await pub.readContract({ address: pool, abi: poolAbi, functionName: "root" })) as Hex;
    record("relayer processes deposits; SDK tree matches on-chain root", BigInt(onchainRoot) === tree1.root(), { root: onchainRoot });

    // 3. Alice pays bob 700 privately, change 300; the relayer submits.
    const aliceNotes = await restore(ALICE_SEED, alice, pool, deploymentId);
    record("alice finds her deposits from seed + public events", sum(aliceNotes) === 1_000_000_000n, { notes: aliceNotes.length });
    const pay = spendWitness({
      keys: alice, deployment: deploymentId, tree: tree1, asset: BigInt(asset), inputs: aliceNotes,
      outputs: [{ value: 700_000_000n, to: addressOf(bob) }, { value: 300_000_000n, to: addressOf(alice) }],
    });
    const t0 = performance.now();
    const payProof = await spendProver.prove(pay.inputs);
    const payMs = Math.round(performance.now() - t0);
    const payTx = await send(KEYS.relayer, pool, poolAbi, "spend", spendArgs(payProof.proof, pay.publicInputs));
    const payLogs = logs(payTx);
    const transfers = payTx.logs.filter((l) => l.address.toLowerCase() === asset.toLowerCase());
    observer.push({ tx: payTx.transactionHash, action: "private transfer", visible: {
      sender: relayerEoa, events: payLogs.map((l) => l.eventName), tokenTransfers: transfers.length,
      publicAsset: pay.publicInputs.publicAsset, withdrawAmount: "0", gasUsed: payTx.gasUsed.toString(), proveMs: payMs,
    } });
    record("private transfer: no token transfer, no asset, no amount, no alice/bob address on chain",
      transfers.length === 0 && BigInt(pay.publicInputs.publicAsset) === 0n
        && !logText(payTx).includes(aliceEoa.slice(2).toLowerCase())
        && !logText(payTx).includes(bobEoa.slice(2).toLowerCase()),
      { events: payLogs.map((l) => l.eventName) });

    // 4. Adversarial: replay, tampering, other deployment.
    const replay = await reverts(KEYS.relayer, pool, "spend", spendArgs(payProof.proof, pay.publicInputs));
    record("replaying the same spend is rejected", replay?.includes("NullifierSpent") ?? false, { replay });
    await processQueue(appendProver, pool, deploymentId, KEYS.relayer);

    const bobNotes = await restore(BOB_SEED, bob, pool, deploymentId);
    record("bob finds exactly 700 by scanning ciphertexts", sum(bobNotes) === 700_000_000n && bobNotes.length === 1, { values: bobNotes.map((n) => n.value.toString()) });

    const tree2 = await chainTree(pool, deploymentId);
    const out = spendWitness({
      keys: bob, deployment: deploymentId, tree: tree2, asset: BigInt(asset), inputs: bobNotes,
      outputs: [{ value: 45_000_000n, to: addressOf(bob) }],
      withdraw: { amount: 650_000_000n, recipient: BigInt(bobEoa) }, relayer: { address: BigInt(relayerEoa), fee: 5_000_000n },
    });
    const outProof = await spendProver.prove(out.inputs);
    const evil = privateKeyToAccount(KEYS.deployer).address;
    const redirected = await reverts(KEYS.relayer, pool, "spend", spendArgs(outProof.proof, { ...out.publicInputs, withdrawRecipient: evil }));
    record("relayer cannot redirect the withdrawal (verifier rejects)", verifierRejected(redirected), { redirected });
    const feeBump = await reverts(KEYS.relayer, pool, "spend", spendArgs(outProof.proof, { ...out.publicInputs, relayerFee: 6_000_000n, withdrawAmount: 649_000_000n }));
    record("relayer cannot raise its fee (verifier rejects)", verifierRejected(feeBump), { feeBump });
    const fakeRoot = await reverts(KEYS.relayer, pool, "spend", spendArgs(outProof.proof, { ...out.publicInputs, root: toHex32(123n) }));
    record("unknown root is rejected", fakeRoot?.includes("UnknownRoot") ?? false, { fakeRoot });
    const nonCanonical = await reverts(KEYS.relayer, pool, "spend", spendArgs(outProof.proof, {
      ...out.publicInputs,
      nullifiers: [toHex32(BigInt(out.publicInputs.nullifiers[0]) + 21888242871839275222246405745257275088548364400416034343698204186575808495617n), out.publicInputs.nullifiers[1]],
    }));
    record("non-canonical nullifier encoding is rejected (no second nullifier slot)", nonCanonical?.includes("NotAFieldElement") ?? false, { nonCanonical });

    // A zero-value spend against the empty root passes every pool precondition on both deployments, so only
    // the deployment id inside the proof can make the second one refuse it.
    const other = deploy(`${ROOT}contracts/deployments/privacy-e2e-other.json`);
    const dummyNote: OwnedNote = (() => {
      const [rho, blind] = [77n, 78n];
      const cm = noteCommitment(deploymentId, BigInt(asset), 0n, noteInner(alice.owner, rho, blind));
      return { leafIndex: 0, asset: BigInt(asset), value: 0n, rho, blind, commitment: cm, nullifier: ownerNullifier(alice.nk, cm) };
    })();
    const zero = spendWitness({ keys: alice, deployment: deploymentId, tree: new MerkleTree(), asset: BigInt(asset), inputs: [dummyNote], outputs: [] });
    const zeroProof = await spendProver.prove(zero.inputs);
    const home = await reverts(KEYS.relayer, pool, "spend", spendArgs(zeroProof.proof, zero.publicInputs));
    const crossDeploy = await reverts(KEYS.relayer, other.pool, "spend", spendArgs(zeroProof.proof, zero.publicInputs));
    record("a proof bound to this deployment is accepted here and rejected by another deployment",
      home === null && verifierRejected(crossDeploy), { home, crossDeploy });

    // 5. Bob unshields 650 to his EOA, pays the relayer 5, keeps 45.
    const before = (await pub.readContract({ address: asset, abi: erc20, functionName: "balanceOf", args: [bobEoa] })) as bigint;
    const outTx = await send(KEYS.relayer, pool, poolAbi, "spend", spendArgs(outProof.proof, out.publicInputs));
    const after = (await pub.readContract({ address: asset, abi: erc20, functionName: "balanceOf", args: [bobEoa] })) as bigint;
    const fee = (await pub.readContract({ address: asset, abi: erc20, functionName: "balanceOf", args: [relayerEoa] })) as bigint;
    observer.push({ tx: outTx.transactionHash, action: "unshield", visible: { sender: relayerEoa, asset, recipient: bobEoa, amount: "650000000", relayerFee: "5000000", events: logs(outTx).map((l) => l.eventName), gasUsed: outTx.gasUsed.toString() } });
    record("bob receives 650 and the relayer 5; bob's EOA never sent a transaction", after - before === 650_000_000n && fee === 5_000_000n, { received: (after - before).toString(), fee: fee.toString() });
    await processQueue(appendProver, pool, deploymentId, KEYS.relayer);

    // 5b. D-05: a relayer can be paid with a shielded note, so no asset or amount becomes public.
    const relayerKeys = deriveKeys(RELAYER_SEED);
    const bobLeft = await restore(BOB_SEED, bob, pool, deploymentId);
    const feePay = spendWitness({
      keys: bob, deployment: deploymentId, tree: await chainTree(pool, deploymentId), asset: BigInt(asset), inputs: bobLeft,
      outputs: [{ value: 44_000_000n, to: addressOf(bob) }, { value: 1_000_000n, to: addressOf(relayerKeys) }],
    });
    const feeTx = await send(KEYS.relayer, pool, poolAbi, "spend", spendArgs((await spendProver.prove(feePay.inputs)).proof, feePay.publicInputs));
    await processQueue(appendProver, pool, deploymentId, KEYS.relayer);
    const relayerNotes = await restore(RELAYER_SEED, relayerKeys, pool, deploymentId);
    record("a relayer is paid privately: its note arrives and no token moves or asset appears on chain",
      sum(relayerNotes) === 1_000_000n && feeTx.logs.filter((l) => l.address.toLowerCase() === asset.toLowerCase()).length === 0 && BigInt(feePay.publicInputs.publicAsset) === 0n,
      { relayerNote: sum(relayerNotes).toString() });

    // 6. Restore from seed and reconcile custody.
    const aliceRestored = await restore(ALICE_SEED, deriveKeys(ALICE_SEED), pool, deploymentId);
    const bobRestored = await restore(BOB_SEED, deriveKeys(BOB_SEED), pool, deploymentId);
    record("fresh wallets restored from seeds see alice 300 and bob 44",
      sum(aliceRestored) === 300_000_000n && sum(bobRestored) === 44_000_000n,
      { alice: sum(aliceRestored).toString(), bob: sum(bobRestored).toString() });
    const custody = (await pub.readContract({ address: asset, abi: erc20, functionName: "balanceOf", args: [pool] })) as bigint;
    record("custody equals all unspent notes (345)", custody === sum(aliceRestored) + sum(bobRestored) + sum(relayerNotes), { custody: custody.toString() });
  } finally {
    await appendProver.destroy();
    await spendProver.destroy();
  }

  writeFileSync(`${outDir}/w1-shielded-flow-local.json`, JSON.stringify({
    note: "Local anvil (31337), dedicated chain. INCOMPLETE W1 FIXTURE: free notes only. Synthetic test identities.",
    steps, observer,
  }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`${steps.length} steps passed`);
}

await main();
