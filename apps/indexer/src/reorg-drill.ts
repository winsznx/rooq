/**
 * Reorg drill (local anvil only). Forks the shared node into a throwaway anvil, indexes it, then
 * replaces the newest blocks with a different branch carrying different Rooq events:
 *
 *   branch A: key 5 faucets mUSD, deposits 600 into MarginVault and swaps 100 mUSD on a pool (5 blocks)
 *   evm_revert to the fork tip
 *   branch B: key 5 faucets less mUSD, deposits 250, then 3 empty blocks                    (6 blocks)
 *
 * and asserts the indexer marked branch A non-canonical, indexed branch B as canonical, that its
 * incrementally maintained derived tables equal a fresh replay, and that reconciliation passes.
 * Evidence: docs/evidence/indexer-reorg-local.json.
 */
import type { Hex } from "viem";
import { loadChain } from "./chain";
import { REDUCER_VERSION, loadConfig } from "./config";
import { connectDb } from "./db";
import { lower } from "./decode";
import { Assertions, DrillWallet, SOURCE_RPC, resetSchema, rpc, startFork, writeEvidence, type SentTx } from "./drill/support";
import { log, logError } from "./log";
import { runMigrations } from "./migrate";
import { replayChain } from "./replay";
import { snapshotDerived } from "./store";
import { Indexer, type ReorgReport, type TickResult } from "./sync";

const PORT = Number(process.env.DRILL_PORT ?? 8555);
const SCHEMA = "drill_reorg";
const UNIT = 10n ** 6n;

const fork = await startFork(PORT);
const config = loadConfig({ ...process.env, ROOQ_ENV: "local", RPC_URL: fork.url, DATABASE_SCHEMA: SCHEMA, RECONCILE_EVERY_BLOCKS: "1" });
const sql = connectDb(config.databaseUrl, { schema: SCHEMA, application: "rooq-reorg-drill", statementTimeoutMs: 120_000 });
const checks = new Assertions();
let exitCode = 0;

interface BlockRow {
  readonly number: bigint;
  readonly hash: Hex;
  readonly canonical: boolean;
}

interface EventRow {
  readonly block_number: bigint;
  readonly block_hash: Hex;
  readonly tx_hash: Hex;
  readonly log_index: number;
  readonly event_name: string | null;
  readonly canonical: boolean;
}

try {
  const chain = await loadChain("local", [fork.url]);
  const client = chain.client;
  await resetSchema(sql, SCHEMA);
  await runMigrations(sql, SCHEMA);
  const indexer = await Indexer.open(chain, sql, config);
  await indexer.catchUp();
  const forkTip = await client.getBlock();
  const tip = { number: forkTip.number, hash: lower(forkTip.hash) };
  log("drill_fork_indexed", { tip, cursor: indexer.currentCursor });

  const wallet = new DrillWallet(client, chain.deployment, chain.chain, fork.url);
  const snapshotId = await rpc(fork.url, "evm_snapshot");
  if (typeof snapshotId !== "string") throw new Error("evm_snapshot returned no id");

  const branchA: SentTx[] = [
    await wallet.faucet(1_000n * UNIT),
    await wallet.approve(chain.deployment.marginVault, 600n * UNIT),
    await wallet.deposit(600n * UNIT),
    await wallet.approve(chain.deployment.spotRouter, 100n * UNIT),
    await wallet.swapCollateralForBase(100n * UNIT),
  ];
  const ticksA = await indexer.catchUp();
  const blocksA = await sql<BlockRow[]>`
    SELECT number, hash, canonical FROM chain_blocks WHERE chain_id = ${chain.deployment.chainId} AND number > ${tip.number.toString()} ORDER BY number`;
  const depositA = branchA[2];
  const swapA = branchA[4];
  if (!depositA || !swapA) throw new Error("branch A transactions missing");

  const reverted = await rpc(fork.url, "evm_revert", [snapshotId]);
  const afterRevert = await client.getBlockNumber({ cacheTime: 0 });
  // A different first transaction guarantees the first replaced block differs, so the ancestor is the tip.
  const branchB: SentTx[] = [await wallet.faucet(800n * UNIT), await wallet.approve(chain.deployment.marginVault, 250n * UNIT), await wallet.deposit(250n * UNIT)];
  await rpc(fork.url, "anvil_mine", ["0x3"]);
  const depositB = branchB[2];
  if (!depositB) throw new Error("branch B deposit missing");
  const headB = await client.getBlock();

  const ticksB: TickResult[] = await indexer.catchUp();
  const reorg: ReorgReport | null = ticksB.find((t) => t.reorg)?.reorg ?? null;

  const blocksAfter = await sql<BlockRow[]>`
    SELECT number, hash, canonical FROM chain_blocks WHERE chain_id = ${chain.deployment.chainId} AND number > ${tip.number.toString()} ORDER BY number, canonical`;
  const orphanedA = blocksAfter.filter((b) => blocksA.some((a) => a.hash === b.hash));
  const canonicalB = blocksAfter.filter((b) => b.canonical);
  const nodeHashes = await Promise.all(canonicalB.map((b) => client.getBlock({ blockNumber: b.number }).then((x) => lower(x.hash))));
  const eventsA = await sql<EventRow[]>`
    SELECT block_number, block_hash, tx_hash, log_index, event_name, canonical FROM raw_events
    WHERE chain_id = ${chain.deployment.chainId} AND tx_hash = ${lower(depositA.hash)} ORDER BY log_index`;
  const eventsB = await sql<EventRow[]>`
    SELECT block_number, block_hash, tx_hash, log_index, event_name, canonical FROM raw_events
    WHERE chain_id = ${chain.deployment.chainId} AND tx_hash = ${lower(depositB.hash)} ORDER BY log_index`;
  const movements = await sql<{ tx_hash: Hex; amount: string; account: Hex }[]>`
    SELECT tx_hash, amount, account FROM vault_movements WHERE chain_id = ${chain.deployment.chainId} AND account = ${lower(wallet.address)} ORDER BY block_number`;
  const tombstones = await sql<{ type: string; block_number: bigint; block_hash: Hex; tx_hash: Hex; event_id: string }[]>`
    SELECT type, block_number, block_hash, tx_hash, event_id FROM stream_events WHERE chain_id = ${chain.deployment.chainId} AND reverted ORDER BY seq`;
  const tradesA = await sql<{ tx_hash: Hex }[]>`
    SELECT tx_hash FROM trades WHERE chain_id = ${chain.deployment.chainId} AND tx_hash = ${lower(swapA.hash)}`;
  const reorgRows = await sql<{ common_ancestor: bigint; depth: number; orphaned_blocks: number; orphaned_events: number }[]>`
    SELECT common_ancestor, depth, orphaned_blocks, orphaned_events FROM reorgs WHERE chain_id = ${chain.deployment.chainId}`;

  const incremental = await snapshotDerived(sql, chain.deployment.chainId);
  const replay = await replayChain(sql, config);
  const reconciliation = await indexer.reconcileNow({ full: true });
  const status = await sql<{ status: string; reason: string | null; last_indexed_block: bigint; last_indexed_hash: Hex }[]>`
    SELECT status, reason, last_indexed_block, last_indexed_hash FROM indexer_status WHERE chain_id = ${chain.deployment.chainId}`;

  checks.check("branch A was indexed before the reorg", blocksA.length === 5 && blocksA.every((b) => b.canonical) && ticksA.some((t) => t.indexedEvents > 0), {
    blocks: blocksA,
  });
  checks.check("evm_revert rewound the fork to its tip", reverted === true && afterRevert === tip.number, { reverted, afterRevert, tip: tip.number });
  checks.check("reorg detected with the fork tip as common ancestor", reorg !== null && reorg.commonAncestor === tip.number && reorg.depth === 5, { reorg });
  checks.check("every branch A block row is now non-canonical", orphanedA.length === 5 && orphanedA.every((b) => !b.canonical), { orphanedA });
  checks.check("branch A deposit events are non-canonical", eventsA.length > 0 && eventsA.every((e) => !e.canonical), { eventsA });
  checks.check(
    "branch B blocks are canonical and match the node",
    canonicalB.length === 6 && canonicalB.every((b, i) => b.hash === nodeHashes[i]) && canonicalB.at(-1)?.number === headB.number,
    { canonicalB, nodeHashes },
  );
  checks.check("branch B deposit events are canonical", eventsB.length > 0 && eventsB.every((e) => e.canonical), { eventsB });
  checks.check(
    "derived vault movements contain only the branch B deposit",
    movements.length === 1 && movements[0]?.tx_hash === lower(depositB.hash) && movements[0]?.amount === (250n * UNIT).toString(),
    { movements },
  );
  checks.check(
    "stream carries a reverted tombstone for the branch A swap",
    tombstones.some((t) => t.type === "pool.swap" && t.tx_hash === lower(swapA.hash) && orphanedA.some((b) => b.hash === t.block_hash)),
    { tombstones },
  );
  checks.check("the branch A swap is gone from derived trades", tradesA.length === 0, { tradesA });
  checks.check("incremental derived state equals a fresh replay", replay.identical && replay.before.sha256 === incremental.sha256, {
    incremental: incremental.sha256,
    replayBefore: replay.before.sha256,
    replayAfter: replay.after.sha256,
  });
  checks.check("reconciliation at the new head passes", reconciliation?.ok === true && reconciliation.blockNumber === headB.number, {
    block: reconciliation?.blockNumber,
    checks: reconciliation?.checks,
    mismatches: reconciliation?.mismatches,
  });
  checks.check("indexer status is ok at the new head", status[0]?.status === "ok" && status[0]?.last_indexed_hash === lower(headB.hash), { status: status[0] });

  const file = writeEvidence("indexer-reorg-local.json", {
    drill: "reorg",
    ok: checks.ok,
    ranAt: new Date().toISOString(),
    env: "local",
    chainId: chain.deployment.chainId,
    rpc: fork.url,
    forkedFrom: SOURCE_RPC,
    schema: SCHEMA,
    reducerVersion: REDUCER_VERSION,
    drillAccount: wallet.address,
    forkTip: tip,
    branchA: { txs: branchA, blocks: blocksA.map((b) => ({ number: b.number, hash: b.hash })) },
    revert: { snapshotId, reverted, headAfterRevert: afterRevert },
    branchB: { txs: branchB, head: { number: headB.number, hash: lower(headB.hash) }, blocks: canonicalB.map((b) => ({ number: b.number, hash: b.hash })) },
    reorg,
    reorgRows,
    rawEvents: { branchA: eventsA, branchB: eventsB },
    vaultMovements: movements,
    tombstones,
    derived: { incremental, replay: { before: replay.before.sha256, after: replay.after.sha256, identical: replay.identical, events: replay.events } },
    reconciliation,
    indexerStatus: status[0] ?? null,
    assertions: checks.list,
  });
  log("drill_complete", { drill: "reorg", ok: checks.ok, evidence: file });
  if (!checks.ok) exitCode = 1;
} catch (error) {
  logError("drill_failed", error);
  exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
  await fork.stop();
}
process.exit(exitCode);
