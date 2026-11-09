import postgres from "postgres";
import { indexerUnavailable } from "./errors";
import { debug, logError } from "./log";

export type Db = postgres.Sql<{ bigint: bigint }>;

/** Connection failures, a missing schema and timeouts mean "history unavailable", not a bug. */
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOENT",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "57P01",
  "57P03",
  "57014",
  "3D000",
  "3F000",
  "42P01",
  "28P01",
  "28000",
]);

export function isUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return typeof error.code === "string" && UNAVAILABLE_CODES.has(error.code);
}

export function connectDb(databaseUrl: string, schema: string): Db {
  const parsed = new URL(databaseUrl);
  const host = parsed.searchParams.get("host") ?? undefined;
  parsed.searchParams.delete("host");
  return postgres(parsed.toString(), {
    ...(host ? { host } : {}),
    max: 10,
    connect_timeout: 2,
    idle_timeout: 30,
    types: { bigint: postgres.BigInt },
    connection: { application_name: "rooq-api", search_path: schema, statement_timeout: 4_000 },
    onnotice: (notice) => debug("postgres_notice", { message: notice.message }),
  });
}

/** Hard ceiling for one history query, below the 5 s route deadline. */
export const HISTORY_TIMEOUT_MS = 2_500;

class HistoryTimeout extends Error {
  readonly code = "HISTORY_TIMEOUT";
}

/**
 * postgres.js backs off between reconnect attempts while the server is down, so a query can wait far
 * longer than connect_timeout. Racing it against a timer keeps the "database unavailable" answer fast.
 */
async function bounded<T>(query: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HistoryTimeout(`history query exceeded ${HISTORY_TIMEOUT_MS} ms`)), HISTORY_TIMEOUT_MS);
  });
  query.catch((error: unknown) => debug("history_query_rejected", { error: error instanceof Error ? error.message : String(error) }));
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(error: unknown): boolean {
  return error instanceof HistoryTimeout || isUnavailable(error);
}

/** After an outage is seen, skip queries for a short window instead of queueing behind reconnects. */
const OPEN_CIRCUIT_MS = 2_000;
const circuit = new WeakMap<Db, number>();

async function run<T>(sql: Db, query: (sql: Db) => Promise<T>): Promise<T> {
  if ((circuit.get(sql) ?? 0) > Date.now()) throw new HistoryTimeout("indexer database marked unavailable");
  try {
    const value = await bounded(query(sql));
    circuit.delete(sql);
    return value;
  } catch (error) {
    if (unavailable(error)) circuit.set(sql, Date.now() + OPEN_CIRCUIT_MS);
    throw error;
  }
}

/** Runs a history query; an unreachable database becomes the INDEXER_BEHIND 503 envelope. */
export async function history<T>(sql: Db, query: (sql: Db) => Promise<T>): Promise<T> {
  try {
    return await run(sql, query);
  } catch (error) {
    if (unavailable(error)) throw indexerUnavailable();
    throw error;
  }
}

/** Like `history`, but for optional enrichment: returns null when the database is unreachable. */
export async function optionalHistory<T>(sql: Db, query: (sql: Db) => Promise<T>): Promise<T | null> {
  try {
    return await run(sql, query);
  } catch (error) {
    if (unavailable(error)) return null;
    logError("history_query_failed", error);
    throw error;
  }
}
