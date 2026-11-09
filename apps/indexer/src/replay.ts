import type { Address } from "viem";
import { getDeployment } from "@rooq/config";
import { loadChain } from "./chain";
import { loadConfig } from "./config";
import { connectDb, type Db } from "./db";
import { lower } from "./decode";
import { log, logError, warn } from "./log";
import { ensureMeta, loadMeta } from "./meta";
import { runMigrations } from "./migrate";
import { rebuildDerived, snapshotDerived, type DerivedSnapshot } from "./store";
import { deploymentTokens, deploymentWatchList, loadDiscovered, reducerContext } from "./watch";

export interface ReplayReport {
  readonly chainId: number;
  readonly events: number;
  readonly violations: number;
  readonly before: DerivedSnapshot;
  readonly after: DerivedSnapshot;
  readonly identical: boolean;
}

async function referencedTokens(sql: Db, chainId: number): Promise<Address[]> {
  const rows = await sql<{ token: Address }[]>`
    SELECT DISTINCT lower(v.token) AS token
    FROM raw_events,
      LATERAL (VALUES (args->>'base'), (args->>'quote'), (args->>'token0'), (args->>'token1')) AS v(token)
    WHERE chain_id = ${chainId} AND canonical AND event_name IN ('MarketCreated', 'PoolCreated') AND v.token IS NOT NULL`;
  return rows.map((r) => r.token);
}

/**
 * Deletes every derived row for the chain and rebuilds it from the stored canonical raw events, in
 * one transaction. Reports digests of the derived tables before and after so drift is visible.
 * RPC is used only if token or feed decimals were never recorded in contract_meta.
 */
export async function replayChain(sql: Db, config: ReturnType<typeof loadConfig>): Promise<ReplayReport> {
  const dep = getDeployment(config.env);
  if (!dep) throw new Error(`No deployment recorded for ${config.env}`);
  const chainId = dep.chainId;
  let meta = await loadMeta(sql, chainId);
  const watched = [...deploymentWatchList(dep), ...(await loadDiscovered(sql, chainId))];
  const tokens = [...deploymentTokens(dep), ...(await referencedTokens(sql, chainId))];
  const feeds = watched.filter((w) => w.kind === "priceFeed").map((w) => lower(w.address));
  const missing = [...tokens, ...feeds].filter((a) => !meta.has(a));
  if (missing.length > 0) {
    warn("replay_meta_missing", { missing });
    const chain = await loadChain(config.env, config.rpcUrls, config.rpcBatchSize);
    meta = await ensureMeta(sql, chain.client, chainId, meta, { tokens, feeds });
  }
  const ctx = reducerContext(dep, meta);
  return sql.begin(async (tx) => {
    const before = await snapshotDerived(tx, chainId);
    const rebuilt = await rebuildDerived(tx, chainId, ctx);
    const after = await snapshotDerived(tx, chainId);
    for (const v of rebuilt.violations.slice(0, 20)) warn("invariant_violation", { entity: v.entity, message: v.message, block: v.at.blockNumber });
    return { chainId, events: rebuilt.events, violations: rebuilt.violations.length, before, after, identical: before.sha256 === after.sha256 };
  });
}

if (import.meta.main) {
  const config = loadConfig();
  const sql = connectDb(config.databaseUrl, { schema: config.schema, application: "rooq-replay", statementTimeoutMs: 600_000, max: 2 });
  try {
    await runMigrations(sql, config.schema);
    const report = await replayChain(sql, config);
    log("replay_complete", {
      schema: config.schema,
      chainId: report.chainId,
      events: report.events,
      violations: report.violations,
      identicalToPrevious: report.identical,
      before: report.before.sha256,
      after: report.after.sha256,
      tables: report.after.tables,
    });
  } catch (error) {
    logError("replay_failed", error);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
