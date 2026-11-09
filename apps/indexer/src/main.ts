import { loadChain } from "./chain";
import { loadConfig } from "./config";
import { connectDb } from "./db";
import { log, logError } from "./log";
import { runMigrations } from "./migrate";
import { Indexer } from "./sync";

const config = loadConfig();
const chain = await loadChain(config.env, config.rpcUrls, config.rpcBatchSize);
const sql = connectDb(config.databaseUrl, { schema: config.schema, application: "rooq-indexer", statementTimeoutMs: 120_000 });
await runMigrations(sql, config.schema);
const indexer = await Indexer.open(chain, sql, config);

let stopping = false;
const stop = (signal: string) => {
  log("indexer_stopping", { signal });
  stopping = true;
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

let failures = 0;
while (!stopping) {
  try {
    const result = await indexer.tick();
    failures = 0;
    if (!result.progressed && !result.reorg) await Bun.sleep(config.pollMs);
  } catch (error) {
    failures += 1;
    logError("tick_failed", error, { failures });
    try {
      await indexer.recordFailure(error);
    } catch (statusError) {
      logError("status_write_failed", statusError);
    }
    await Bun.sleep(Math.min(30_000, config.pollMs * 2 ** Math.min(failures, 5)));
  }
}

await sql.end({ timeout: 5 });
log("indexer_stopped", { cursor: indexer.currentCursor });
