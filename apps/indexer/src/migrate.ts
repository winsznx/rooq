import { loadConfig } from "./config";
import { connectDb, type Db } from "./db";
import { log, logError } from "./log";
import { MIGRATIONS } from "./migrations";

const MIGRATION_LOCK = 0x726f6f71; // "rooq"

export interface MigrationReport {
  readonly applied: readonly number[];
  readonly pending: readonly number[];
}

async function appliedVersions(sql: Db): Promise<Set<number>> {
  const rows = await sql<{ version: number }[]>`SELECT version FROM schema_migrations`;
  return new Set(rows.map((r) => r.version));
}

/**
 * Idempotent: each migration runs in its own transaction under an advisory lock and is skipped when
 * schema_migrations already records it. With dryRun nothing is written beyond the bookkeeping table.
 */
export async function runMigrations(sql: Db, schema: string, opts: { dryRun?: boolean } = {}): Promise<MigrationReport> {
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const done = await appliedVersions(sql);
  const pending = MIGRATIONS.filter((m) => !done.has(m.version)).map((m) => m.version);
  if (opts.dryRun) return { applied: [], pending };

  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    const ran = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
      const already = await tx`SELECT 1 FROM schema_migrations WHERE version = ${migration.version}`;
      if (already.length > 0) return false;
      for (const statement of migration.statements) await tx.unsafe(statement);
      await tx`INSERT INTO schema_migrations (version, name) VALUES (${migration.version}, ${migration.name})`;
      return true;
    });
    if (ran) applied.push(migration.version);
  }
  return { applied, pending };
}

if (import.meta.main) {
  const config = loadConfig();
  const dryRun = process.argv.includes("--dry-run");
  const sql = connectDb(config.databaseUrl, { schema: config.schema, application: "rooq-migrate", statementTimeoutMs: 60_000, max: 1 });
  try {
    const report = await runMigrations(sql, config.schema, { dryRun });
    log(dryRun ? "migrations_dry_run" : "migrations_applied", { schema: config.schema, ...report, known: MIGRATIONS.map((m) => m.version) });
  } catch (error) {
    logError("migrations_failed", error, { schema: config.schema });
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
