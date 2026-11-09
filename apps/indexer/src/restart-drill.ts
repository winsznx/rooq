/**
 * Restart drill (local anvil only). Forks the shared node into a throwaway anvil and runs the real
 * indexer process (`bun run src/main.ts`) against it. Once it has caught up the process is killed
 * with SIGKILL (no graceful shutdown), key 5 sends a deposit, a withdrawal and a pool swap, a few
 * empty blocks are mined, and the indexer is started again. Asserts it resumed from its stored
 * cursor and that the canonical block and event sets have no gaps and no duplicates.
 * Evidence: docs/evidence/indexer-restart-local.json.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex, Log } from "viem";
import { loadChain } from "./chain";
import { REDUCER_VERSION, loadConfig } from "./config";
import { connectDb } from "./db";
import { lower } from "./decode";
import { Assertions, DrillWallet, SOURCE_RPC, resetSchema, rpc, startFork, writeEvidence, type SentTx } from "./drill/support";
import { log, logError } from "./log";
import { runMigrations } from "./migrate";
import { replayChain } from "./replay";
import { snapshotDerived } from "./store";
import { deploymentWatchList } from "./watch";

const PORT = Number(process.env.DRILL_PORT ?? 8556);
const SCHEMA = "drill_restart";
const UNIT = 10n ** 6n;
const APP_DIR = join(import.meta.dir, "..");
const RUN_DIR = mkdtempSync(join(tmpdir(), "rooq-restart-drill-"));

const fork = await startFork(PORT);
const config = loadConfig({ ...process.env, ROOQ_ENV: "local", RPC_URL: fork.url, DATABASE_SCHEMA: SCHEMA, RECONCILE_EVERY_BLOCKS: "1" });
const sql = connectDb(config.databaseUrl, { schema: SCHEMA, application: "rooq-restart-drill", statementTimeoutMs: 120_000 });
const checks = new Assertions();
let exitCode = 0;
let running: Bun.Subprocess | null = null;

interface Cursor {
  readonly last_block: bigint;
  readonly last_hash: Hex;
}

function startIndexer(logFile: string): Bun.Subprocess {
  rmSync(logFile, { force: true });
  const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, ROOQ_ENV: "local", RPC_URL: fork.url, DATABASE_SCHEMA: SCHEMA, INDEXER_POLL_MS: "200", RECONCILE_EVERY_BLOCKS: "1" },
    stdout: Bun.file(logFile),
    stderr: Bun.file(`${logFile}.err`),
  });
  log("drill_indexer_started", { pid: proc.pid, logFile });
  return proc;
}

async function cursor(chainId: number): Promise<Cursor | null> {
  const rows = await sql<Cursor[]>`SELECT last_block, last_hash FROM indexer_cursors WHERE chain_id = ${chainId} AND stream = 'rooq'`;
  return rows[0] ?? null;
}

async function waitForCursor(chainId: number, block: bigint, proc: Bun.Subprocess): Promise<Cursor> {
  for (let i = 0; i < 300; i += 1) {
    if (proc.exitCode !== null) throw new Error(`indexer exited early with code ${proc.exitCode}`);
    const c = await cursor(chainId);
    if (c && c.last_block >= block) return c;
    await Bun.sleep(100);
  }
  throw new Error(`indexer did not reach block ${block}`);
}

function logLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l): unknown => JSON.parse(l))
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
}

try {
  const chain = await loadChain("local", [fork.url]);
  const client = chain.client;
  const chainId = chain.deployment.chainId;
  await resetSchema(sql, SCHEMA);
  await runMigrations(sql, SCHEMA);

  const firstLog = join(RUN_DIR, "restart-run-1.log");
  const secondLog = join(RUN_DIR, "restart-run-2.log");
  const tip = await client.getBlock();
  running = startIndexer(firstLog);
  const before = await waitForCursor(chainId, tip.number, running);
  running.kill("SIGKILL");
  const killedWith = await running.exited;
  running = null;
  log("drill_indexer_killed", { cursor: before, exit: killedWith });

  const wallet = new DrillWallet(client, chain.deployment, chain.chain, fork.url);
  const sent: SentTx[] = [
    await wallet.faucet(2_000n * UNIT),
    await wallet.approve(chain.deployment.marginVault, 1_500n * UNIT),
    await wallet.deposit(1_500n * UNIT),
    await wallet.withdraw(400n * UNIT),
    await wallet.approve(chain.deployment.spotRouter, 100n * UNIT),
    await wallet.swapCollateralForBase(100n * UNIT),
  ];
  await rpc(fork.url, "anvil_mine", ["0x3"]);
  const head = await client.getBlock();
  const whileDown = await cursor(chainId);

  running = startIndexer(secondLog);
  const after = await waitForCursor(chainId, head.number, running);
  // Let the caught-up process run its reconciliation tick before stopping it gracefully.
  for (let i = 0; i < 50; i += 1) {
    const rows = await sql<{ n: bigint }[]>`SELECT count(*) AS n FROM reconciliations WHERE chain_id = ${chainId} AND block_number = ${head.number.toString()}`;
    if ((rows[0]?.n ?? 0n) > 0n) break;
    await Bun.sleep(100);
  }
  running.kill("SIGTERM");
  const stoppedWith = await running.exited;
  running = null;

  const blockStats = await sql<{ n: bigint; lo: bigint; hi: bigint; distinct_numbers: bigint }[]>`
    SELECT count(*) AS n, min(number) AS lo, max(number) AS hi, count(DISTINCT number) AS distinct_numbers
    FROM chain_blocks WHERE chain_id = ${chainId} AND canonical`;
  const gaps = await sql<{ number: bigint }[]>`
    SELECT g.number FROM generate_series(${chain.deployment.deployBlock}::bigint, ${head.number.toString()}::bigint) AS g(number)
    LEFT JOIN chain_blocks b ON b.chain_id = ${chainId} AND b.canonical AND b.number = g.number
    WHERE b.number IS NULL`;
  const duplicateEvents = await sql<{ tx_hash: Hex; log_index: number; n: bigint }[]>`
    SELECT tx_hash, log_index, count(*) AS n FROM raw_events WHERE chain_id = ${chainId} AND canonical
    GROUP BY tx_hash, log_index HAVING count(*) > 1`;
  const stored = await sql<{ block_hash: Hex; log_index: number }[]>`
    SELECT block_hash, log_index FROM raw_events WHERE chain_id = ${chainId} AND canonical`;
  const watched = await sql<{ address: Address }[]>`SELECT address FROM watched_addresses WHERE chain_id = ${chainId}`;
  const addresses = [...new Set([...deploymentWatchList(chain.deployment).map((w) => w.address), ...watched.map((w) => w.address)])];
  const nodeLogs: Log[] = await client.getLogs({ address: addresses, fromBlock: BigInt(chain.deployment.deployBlock), toBlock: head.number });
  const nodeKeys = new Set(nodeLogs.map((l) => `${lower(l.blockHash ?? "0x")}:${l.logIndex}`));
  const storedKeys = new Set(stored.map((r) => `${r.block_hash}:${r.log_index}`));
  const missing = [...nodeKeys].filter((k) => !storedKeys.has(k));
  const extra = [...storedKeys].filter((k) => !nodeKeys.has(k));

  const perTx = await Promise.all(
    sent.map(async (tx) => {
      const receipt = await client.getTransactionReceipt({ hash: tx.hash });
      const watchedLogs = receipt.logs.filter((l) => addresses.includes(lower(l.address))).length;
      const rows = await sql<{ n: bigint }[]>`SELECT count(*) AS n FROM raw_events WHERE chain_id = ${chainId} AND canonical AND tx_hash = ${lower(tx.hash)}`;
      return { step: tx.step, hash: tx.hash, block: tx.block, watchedLogs, indexedRows: Number(rows[0]?.n ?? 0n) };
    }),
  );

  const resumeLines = logLines(secondLog);
  const opened = resumeLines.find((l) => l.event === "indexer_opened");
  const firstRange = resumeLines.find((l) => l.event === "range_indexed");
  const firstRunRanges = logLines(firstLog).filter((l) => l.event === "range_indexed").length;
  const reconciliation = await sql<{ block_number: bigint; ok: boolean; checks: number; mismatches: number }[]>`
    SELECT block_number, ok, checks, mismatches FROM reconciliations WHERE chain_id = ${chainId} ORDER BY id DESC LIMIT 1`;
  const status = await sql<{ status: string; reason: string | null; last_indexed_block: bigint; last_indexed_hash: Hex }[]>`
    SELECT status, reason, last_indexed_block, last_indexed_hash FROM indexer_status WHERE chain_id = ${chainId}`;
  const movements = await sql<{ kind: string; amount: string; tx_hash: Hex }[]>`
    SELECT kind, amount, tx_hash FROM vault_movements WHERE chain_id = ${chainId} AND account = ${lower(wallet.address)} ORDER BY block_number`;
  const incremental = await snapshotDerived(sql, chainId);
  const replay = await replayChain(sql, config);

  const stats = blockStats[0];
  checks.check("first run caught up to the fork tip before the kill", before.last_block === tip.number && before.last_hash === lower(tip.hash) && firstRunRanges > 0, {
    cursor: before,
    tip: { number: tip.number, hash: lower(tip.hash) },
  });
  checks.check("nothing was indexed while the process was down", whileDown?.last_block === before.last_block && whileDown?.last_hash === before.last_hash, { whileDown });
  checks.check("restarted process opened from the stored cursor", JSON.stringify(opened?.cursor) === JSON.stringify({ block: before.last_block.toString(), hash: before.last_hash }), {
    opened: opened?.cursor,
  });
  checks.check("first range after restart starts at cursor + 1", firstRange?.from === (before.last_block + 1n).toString(), { firstRange });
  checks.check("caught up to the new head", after.last_block === head.number && after.last_hash === lower(head.hash), {
    cursor: after,
    head: { number: head.number, hash: lower(head.hash) },
  });
  checks.check(
    "canonical blocks are contiguous from the deploy block with one row per height",
    stats !== undefined && stats.n === stats.distinct_numbers && stats.lo === BigInt(chain.deployment.deployBlock) && stats.hi === head.number && stats.n === head.number - stats.lo + 1n && gaps.length === 0,
    { stats, gaps: gaps.map((g) => g.number) },
  );
  checks.check("no canonical event is stored twice", duplicateEvents.length === 0, { duplicateEvents });
  checks.check("canonical raw events equal the node's logs for every watched address", missing.length === 0 && extra.length === 0 && nodeKeys.size === storedKeys.size, {
    node: nodeKeys.size,
    stored: storedKeys.size,
    missing,
    extra,
  });
  checks.check("each drill transaction is indexed exactly once", perTx.every((t) => t.indexedRows === t.watchedLogs), { perTx });
  checks.check(
    "vault movements show the deposit and withdrawal sent while the indexer was down",
    movements.map((m) => `${m.kind}:${m.amount}`).join(",") === `deposit:${1_500n * UNIT},withdraw:${400n * UNIT}`,
    { movements },
  );
  checks.check("incremental derived state equals a fresh replay", replay.identical && replay.before.sha256 === incremental.sha256, {
    incremental: incremental.sha256,
    replayBefore: replay.before.sha256,
    replayAfter: replay.after.sha256,
  });
  checks.check("latest reconciliation is at the head and passed", reconciliation[0]?.ok === true && reconciliation[0]?.block_number === head.number, {
    reconciliation: reconciliation[0],
  });
  checks.check("indexer status is ok", status[0]?.status === "ok", { status: status[0] });

  const file = writeEvidence("indexer-restart-local.json", {
    drill: "restart",
    ok: checks.ok,
    ranAt: new Date().toISOString(),
    env: "local",
    chainId,
    rpc: fork.url,
    forkedFrom: SOURCE_RPC,
    schema: SCHEMA,
    reducerVersion: REDUCER_VERSION,
    drillAccount: wallet.address,
    firstRun: { cursorAtKill: before, killedWith: "SIGKILL", exitCode: killedWith, rangesIndexed: firstRunRanges },
    whileDown: { txs: sent, emptyBlocksMined: 3, cursor: whileDown },
    secondRun: { opened: opened ?? null, firstRange: firstRange ?? null, cursor: after, stoppedWith: "SIGTERM", exitCode: stoppedWith },
    head: { number: head.number, hash: lower(head.hash) },
    blocks: stats ?? null,
    gaps: gaps.map((g) => g.number),
    events: { node: nodeKeys.size, stored: storedKeys.size, missing, extra, duplicates: duplicateEvents },
    perTx,
    vaultMovements: movements,
    derived: { incremental, replay: { before: replay.before.sha256, after: replay.after.sha256, identical: replay.identical, events: replay.events } },
    reconciliation: reconciliation[0] ?? null,
    indexerStatus: status[0] ?? null,
    assertions: checks.list,
  });
  log("drill_complete", { drill: "restart", ok: checks.ok, evidence: file });
  if (!checks.ok) exitCode = 1;
} catch (error) {
  logError("drill_failed", error);
  exitCode = 1;
} finally {
  if (running) {
    running.kill("SIGKILL");
    await running.exited;
  }
  await sql.end({ timeout: 5 });
  await fork.stop();
}
process.exit(exitCode);
