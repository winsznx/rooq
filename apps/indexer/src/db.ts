import postgres from "postgres";
import { debug } from "./log";

export type DbTypes = { bigint: bigint };
export type Db = postgres.Sql<DbTypes>;
export type DbTx = postgres.TransactionSql<DbTypes>;
/** Either a pool connection or an open transaction. */
export type Queryable = postgres.ISql<DbTypes>;

export interface DbOptions {
  readonly schema: string;
  readonly application: string;
  readonly statementTimeoutMs: number;
  readonly connectTimeoutSeconds?: number;
  readonly max?: number;
}

/**
 * postgres.js ignores libpq's `?host=/socket/dir` query parameter (it would forward it as a startup
 * setting), so the socket directory is lifted out of the URL and passed as the host option.
 */
export function splitSocketHost(url: string): { url: string; host: string | undefined } {
  const parsed = new URL(url);
  const host = parsed.searchParams.get("host") ?? undefined;
  parsed.searchParams.delete("host");
  return { url: parsed.toString(), host };
}

export function connectDb(databaseUrl: string, options: DbOptions): Db {
  const { url, host } = splitSocketHost(databaseUrl);
  return postgres(url, {
    ...(host ? { host } : {}),
    max: options.max ?? 5,
    connect_timeout: options.connectTimeoutSeconds ?? 5,
    idle_timeout: 30,
    types: { bigint: postgres.BigInt },
    connection: {
      application_name: options.application,
      search_path: options.schema,
      statement_timeout: options.statementTimeoutMs,
    },
    onnotice: (notice) => debug("postgres_notice", { message: notice.message }),
  });
}

/** Postgres limits a statement to 65535 bind parameters; bulk inserts are chunked below that. */
export const MAX_PARAMETERS = 60_000;
