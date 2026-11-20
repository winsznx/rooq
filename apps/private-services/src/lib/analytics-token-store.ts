import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";
import type { Cursor } from "./analytics-store";

/**
 * The $ROOQ index: pool swaps and ERC-20 balances on mainnet, in its own SQLite file with its own cursor so it never
 * shares a rebuild with the testnet index. Everything here is public chain data and can be rebuilt by deleting the file.
 * Trader and holder addresses stay inside; only counts leave.
 */

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), block INTEGER NOT NULL, block_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS swaps (
    block INTEGER NOT NULL, log_index INTEGER NOT NULL, time INTEGER NOT NULL, trader TEXT NOT NULL,
    amount0 TEXT NOT NULL, amount1 TEXT NOT NULL, sqrt_price TEXT NOT NULL, PRIMARY KEY (block, log_index)
  );
  CREATE INDEX IF NOT EXISTS swaps_time ON swaps (time);
  CREATE TABLE IF NOT EXISTS balances (address TEXT PRIMARY KEY, balance TEXT NOT NULL);
  `,
];

const TABLES = ["cursor", "swaps", "balances"] as const;

/** One pool swap. Amounts are from the swapper's side: negative is paid into the pool. */
export interface SwapRow {
  readonly block: number;
  readonly logIndex: number;
  readonly time: number;
  /** The transaction sender. The event's own sender is the router. */
  readonly trader: string;
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly sqrtPriceX96: bigint;
}

export interface TransferRow {
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
}

export interface TokenBatch {
  readonly swaps: readonly SwapRow[];
  /** In log order: balances are applied one transfer at a time. */
  readonly transfers: readonly TransferRow[];
}

export interface StoredSwap {
  readonly time: number;
  readonly amount0: bigint;
  readonly sqrtPriceX96: bigint;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class TokenStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.run(MIGRATIONS[i]!);
        this.db.run(`PRAGMA user_version = ${i + 1}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  /** Clears the index when the token, pool or start block changes. Returns true when it reset. */
  ensureSource(fingerprint: string): boolean {
    const current = this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get("source")?.value ?? null;
    if (current === fingerprint) return false;
    this.db.transaction(() => {
      this.clearTables();
      this.db.run("INSERT INTO meta (key, value) VALUES ('source', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [fingerprint]);
    })();
    return current !== null;
  }

  /** Drops the whole index. Balances can't be unwound one range at a time, so a reorg past finality rebuilds. */
  reset(): void {
    this.db.transaction(() => this.clearTables())();
  }

  private clearTables(): void {
    for (const table of TABLES) this.db.run(`DELETE FROM ${table}`);
  }

  cursor(): Cursor | null {
    const row = this.db.query<{ block: number; block_hash: Hex }, []>("SELECT block, block_hash FROM cursor WHERE id = 1").get();
    return row ? { block: row.block, hash: row.block_hash } : null;
  }

  /** Writes one range, applies its transfers in order and moves the cursor, atomically. */
  commit(batch: TokenBatch, range: { readonly from: number; readonly to: number; readonly hash: Hex }): void {
    const db = this.db;
    db.transaction(() => {
      const cursor = this.cursor();
      if (cursor && cursor.block !== range.from - 1) throw new Error(`Range starts at ${range.from} but the cursor is at ${cursor.block}`);
      const swap = db.prepare<unknown, [number, number, number, string, string, string, string]>(
        "INSERT OR IGNORE INTO swaps (block, log_index, time, trader, amount0, amount1, sqrt_price) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const s of batch.swaps) swap.run(s.block, s.logIndex, s.time, s.trader.toLowerCase(), s.amount0.toString(), s.amount1.toString(), s.sqrtPriceX96.toString());
      const read = db.prepare<{ balance: string }, [string]>("SELECT balance FROM balances WHERE address = ?");
      const write = db.prepare<unknown, [string, string]>("INSERT INTO balances (address, balance) VALUES (?, ?) ON CONFLICT (address) DO UPDATE SET balance = excluded.balance");
      const remove = db.prepare<unknown, [string]>("DELETE FROM balances WHERE address = ?");
      const move = (address: string, delta: bigint): void => {
        if (address === ZERO_ADDRESS) return;
        const next = BigInt(read.get(address)?.balance ?? "0") + delta;
        if (next === 0n) remove.run(address);
        else write.run(address, next.toString());
      };
      for (const t of batch.transfers) {
        move(t.from.toLowerCase(), -t.value);
        move(t.to.toLowerCase(), t.value);
      }
      db.run("INSERT INTO cursor (id, block, block_hash) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET block = excluded.block, block_hash = excluded.block_hash", [range.to, range.hash.toLowerCase()]);
    })();
  }

  /** Addresses holding a positive balance, leaving out `exclude` (burn sinks and the pool manager). */
  holders(exclude: readonly string[]): number {
    const skip = exclude.map((a) => a.toLowerCase());
    return this.db
      .query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM balances WHERE balance NOT LIKE '-%' AND address NOT IN (${skip.map(() => "?").join(",") || "''"})`)
      .get(...skip)!.n;
  }

  swapsSince(since: number): StoredSwap[] {
    return this.db
      .query<{ time: number; amount0: string; sqrt_price: string }, [number]>("SELECT time, amount0, sqrt_price FROM swaps WHERE time >= ? ORDER BY block, log_index")
      .all(since)
      .map((r) => ({ time: r.time, amount0: BigInt(r.amount0), sqrtPriceX96: BigInt(r.sqrt_price) }));
  }

  /** The last swap before `time`, which sets the price a window opens at. */
  lastSwapBefore(time: number): StoredSwap | null {
    const r = this.db.query<{ time: number; amount0: string; sqrt_price: string }, [number]>("SELECT time, amount0, sqrt_price FROM swaps WHERE time < ? ORDER BY block DESC, log_index DESC LIMIT 1").get(time);
    return r ? { time: r.time, amount0: BigInt(r.amount0), sqrtPriceX96: BigInt(r.sqrt_price) } : null;
  }

  uniqueTraders(since: number): number {
    return this.db.query<{ n: number }, [number]>("SELECT COUNT(DISTINCT trader) AS n FROM swaps WHERE time >= ?").get(since)!.n;
  }
}
