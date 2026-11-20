import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DeviceClass, PvSite, TxCategory, WalletSource } from "@rooq/private-sdk/admin";
import type { Hex } from "viem";

/**
 * The analytics index: public chain data and aggregate pageview counts in one SQLite file. Everything chain-derived can
 * be rebuilt by deleting the file. Addresses are stored lowercased and only ever leave as counts, except operator EOAs.
 */

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), block INTEGER NOT NULL, block_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL, time INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS txs (
    hash TEXT PRIMARY KEY, block INTEGER NOT NULL, time INTEGER NOT NULL, from_address TEXT NOT NULL, to_address TEXT,
    selector TEXT NOT NULL, action TEXT NOT NULL, category TEXT NOT NULL, gas_used TEXT NOT NULL, effective_gas_price TEXT NOT NULL,
    fee_wei TEXT NOT NULL, status INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS txs_time ON txs (time);
  CREATE INDEX IF NOT EXISTS txs_block ON txs (block);
  CREATE INDEX IF NOT EXISTS txs_from ON txs (from_address, time);
  CREATE TABLE IF NOT EXISTS shields (
    block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx TEXT NOT NULL, time INTEGER NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL,
    from_address TEXT NOT NULL, PRIMARY KEY (block, log_index)
  );
  CREATE INDEX IF NOT EXISTS shields_time ON shields (time);
  CREATE TABLE IF NOT EXISTS unshields (
    block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx TEXT NOT NULL, time INTEGER NOT NULL, asset TEXT NOT NULL, recipient TEXT NOT NULL,
    amount TEXT NOT NULL, relayer TEXT NOT NULL, fee TEXT NOT NULL, PRIMARY KEY (block, log_index)
  );
  CREATE INDEX IF NOT EXISTS unshields_time ON unshields (time);
  CREATE TABLE IF NOT EXISTS markets_created (
    market INTEGER PRIMARY KEY, creator TEXT NOT NULL, tier TEXT NOT NULL, bond TEXT NOT NULL, block INTEGER NOT NULL, time INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wallets (address TEXT PRIMARY KEY, first_block INTEGER NOT NULL, first_time INTEGER NOT NULL, first_source TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS wallets_time ON wallets (first_time);
  CREATE TABLE IF NOT EXISTS event_counts (
    hour INTEGER NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, first_block INTEGER NOT NULL, last_block INTEGER NOT NULL, last_time INTEGER NOT NULL,
    PRIMARY KEY (hour, kind)
  );
  CREATE INDEX IF NOT EXISTS event_counts_last_block ON event_counts (last_block);
  CREATE TABLE IF NOT EXISTS oracle_gas (
    hour INTEGER NOT NULL, feed TEXT NOT NULL, from_address TEXT NOT NULL, fee_wei TEXT NOT NULL, block INTEGER NOT NULL, PRIMARY KEY (hour, feed)
  );
  CREATE TABLE IF NOT EXISTS pageviews (
    hour INTEGER NOT NULL, site TEXT NOT NULL, route TEXT NOT NULL, referrer_host TEXT NOT NULL, device TEXT NOT NULL,
    views INTEGER NOT NULL, visits INTEGER NOT NULL, PRIMARY KEY (hour, site, route, referrer_host, device)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS oracle_prices (
    hour INTEGER NOT NULL, feed TEXT NOT NULL, answer TEXT NOT NULL, updated_at INTEGER NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
    PRIMARY KEY (hour, feed)
  );
  CREATE INDEX IF NOT EXISTS oracle_prices_block ON oracle_prices (block);
  `,
];

/** Tables rebuilt from chain. Pageviews are not chain data and survive a rebuild. */
const CHAIN_TABLES = ["cursor", "blocks", "txs", "shields", "unshields", "markets_created", "wallets", "event_counts", "oracle_gas", "oracle_prices"] as const;

export const HOUR = 3_600;

export const hourOf = (unixSeconds: number): number => Math.floor(unixSeconds / HOUR) * HOUR;

export interface Cursor {
  readonly block: number;
  readonly hash: Hex;
}

export interface BlockRow {
  readonly number: number;
  readonly hash: Hex;
  readonly time: number;
}

export interface TxRow {
  readonly hash: Hex;
  readonly block: number;
  readonly time: number;
  readonly from: string;
  readonly to: string | null;
  readonly selector: Hex;
  readonly action: string;
  readonly category: Exclude<TxCategory, "oracle">;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly reverted: boolean;
}

export interface ShieldRow {
  readonly block: number;
  readonly logIndex: number;
  readonly tx: Hex;
  readonly time: number;
  readonly asset: string;
  readonly amount: bigint;
  readonly from: string;
}

export interface UnshieldRow {
  readonly block: number;
  readonly logIndex: number;
  readonly tx: Hex;
  readonly time: number;
  readonly asset: string;
  readonly recipient: string;
  readonly amount: bigint;
  readonly relayer: string;
  readonly fee: bigint;
}

export interface MarketCreatedRow {
  readonly market: number;
  readonly creator: string;
  readonly tier: bigint;
  readonly bond: bigint;
  readonly block: number;
  readonly time: number;
}

export interface WalletSighting {
  readonly address: string;
  readonly block: number;
  readonly time: number;
  readonly source: WalletSource;
}

/** One indexed log. The store aggregates these into hourly counts. */
export interface EventSighting {
  readonly kind: string;
  readonly block: number;
  readonly time: number;
}

/** One sampled oracle write per feed per hour, standing in for the gas of every write that hour. */
export interface OracleGasSample {
  readonly hour: number;
  readonly feed: string;
  readonly from: string;
  readonly feeWei: bigint;
  readonly block: number;
}

/** One oracle answer. The store keeps only the last answer per feed per hour. */
export interface OracleAnswer {
  readonly feed: string;
  readonly answer: bigint;
  readonly updatedAt: number;
  readonly block: number;
  readonly logIndex: number;
}

export interface IndexBatch {
  readonly blocks: readonly BlockRow[];
  readonly txs: readonly TxRow[];
  readonly shields: readonly ShieldRow[];
  readonly unshields: readonly UnshieldRow[];
  readonly marketsCreated: readonly MarketCreatedRow[];
  readonly wallets: readonly WalletSighting[];
  readonly events: readonly EventSighting[];
  readonly oracleGas: readonly OracleGasSample[];
  readonly prices: readonly OracleAnswer[];
}

export interface PageviewRecord {
  readonly hour: number;
  readonly site: PvSite;
  readonly route: string;
  readonly referrerHost: string | null;
  readonly device: DeviceClass;
  readonly visit: boolean;
}

export interface BucketCount {
  readonly t: number;
  readonly n: number;
}

export interface CategoryCount {
  readonly category: Exclude<TxCategory, "oracle">;
  readonly n: number;
  readonly reverted: number;
}

export interface ActionCount extends CategoryCount {
  readonly action: string;
}

export interface AmountRow {
  readonly time: number;
  readonly asset: string;
  readonly amount: string;
}

export interface UnshieldAmountRow extends AmountRow {
  readonly fee: string;
}

export interface HourlyPrice {
  readonly hour: number;
  readonly feed: string;
  readonly answer: string;
}

export interface ActionBucketCount {
  readonly action: string;
  readonly t: number;
  readonly n: number;
}

export interface ActiveWallets {
  readonly active: number;
  /** Active in the window and first seen in it. */
  readonly fresh: number;
}

export interface OperatorActionCount {
  readonly from: string;
  readonly action: string;
  readonly n: number;
}

export interface OperatorTxTotals {
  readonly from: string;
  readonly n: number;
  readonly last: number;
}

export interface OracleWrites {
  readonly from: string;
  /** Sampled fee for the hour, times the writes that hour, summed. */
  readonly feeWei: bigint;
  readonly n: number;
  readonly last: number;
}

export type TrafficDimension = "route" | "referrer" | "device" | "site";

export interface TrafficCount {
  readonly key: string;
  readonly views: number;
  readonly visits: number;
}

export interface TrafficBucket {
  readonly t: number;
  readonly views: number;
  readonly visits: number;
}

/**
 * The beacon is unauthenticated, so the referrer is the one dimension a client can make up freely. Each hour keeps at
 * most this many distinct referrer hosts and files later ones under OTHER_REFERRER, so the table and the response stay
 * bounded whatever is posted.
 */
export const REFERRERS_PER_HOUR = 50;
/** Referrer rows a traffic response lists; the rest are summed into one "other" row. */
export const REFERRER_ROWS = 50;
/** Stored for overflow referrers. A beacon can't send it, since `ref` must be a host name. */
const OTHER_REFERRER = "*";
const OTHER_KEY = "other";

const TRAFFIC_KEY: Record<TrafficDimension, string> = {
  route: "site || ':' || route",
  referrer: `CASE referrer_host WHEN '' THEN 'direct' WHEN '${OTHER_REFERRER}' THEN '${OTHER_KEY}' ELSE referrer_host END`,
  device: "device",
  site: "site",
};

const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");

export class AnalyticsStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.run(MIGRATIONS[i]!);
        this.db.run(`PRAGMA user_version = ${i + 1}`);
      })();
    }
  }

  /**
   * Clears the chain index when what it was built from changes (deployment, start block, watched contracts), so a
   * stale cursor never skips history for a newly watched address. Returns true when it reset.
   */
  ensureSource(fingerprint: string): boolean {
    const current = this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get("source")?.value ?? null;
    if (current === fingerprint) return false;
    this.db.transaction(() => {
      for (const table of CHAIN_TABLES) this.db.run(`DELETE FROM ${table}`);
      this.db.run("INSERT INTO meta (key, value) VALUES ('source', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [fingerprint]);
    })();
    return current !== null;
  }

  cursor(): Cursor | null {
    const row = this.db.query<{ block: number; block_hash: Hex }, []>("SELECT block, block_hash FROM cursor WHERE id = 1").get();
    return row ? { block: row.block, hash: row.block_hash } : null;
  }

  blockTime(block: number): number | null {
    return this.db.query<{ time: number }, [number]>("SELECT time FROM blocks WHERE number = ?").get(block)?.time ?? null;
  }

  knownBlockAtOrBelow(block: number): { number: number; hash: Hex } | null {
    return this.db.query<{ number: number; hash: Hex }, [number]>("SELECT number, hash FROM blocks WHERE number <= ? ORDER BY number DESC LIMIT 1").get(block);
  }

  hasTx(hash: Hex): boolean {
    return this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM txs WHERE hash = ?").get(hash.toLowerCase()) !== null;
  }

  hasOracleSample(hour: number, feed: string): boolean {
    return this.db.query<{ one: number }, [number, string]>("SELECT 1 AS one FROM oracle_gas WHERE hour = ? AND feed = ?").get(hour, feed.toLowerCase()) !== null;
  }

  /**
   * Writes one indexed block range and moves the cursor to its end, atomically. Event counts are aggregates, so a range
   * must start right after the cursor: committing one twice would count it twice.
   */
  commit(batch: IndexBatch, range: { readonly from: number; readonly to: number; readonly hash: Hex }): void {
    const db = this.db;
    db.transaction(() => {
      const cursor = this.cursor();
      if (cursor && cursor.block !== range.from - 1) throw new Error(`Range starts at ${range.from} but the cursor is at ${cursor.block}`);
      const block = db.prepare<unknown, [number, string, number]>("INSERT OR IGNORE INTO blocks (number, hash, time) VALUES (?, ?, ?)");
      for (const b of batch.blocks) block.run(b.number, b.hash.toLowerCase(), b.time);
      const tx = db.prepare<unknown, [string, number, number, string, string | null, string, string, string, string, string, string, number]>(
        "INSERT OR IGNORE INTO txs (hash, block, time, from_address, to_address, selector, action, category, gas_used, effective_gas_price, fee_wei, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const t of batch.txs) {
        tx.run(t.hash.toLowerCase(), t.block, t.time, t.from.toLowerCase(), t.to?.toLowerCase() ?? null, t.selector, t.action, t.category, t.gasUsed.toString(), t.effectiveGasPrice.toString(), (t.gasUsed * t.effectiveGasPrice).toString(), t.reverted ? 0 : 1);
      }
      const shield = db.prepare<unknown, [number, number, string, number, string, string, string]>("INSERT OR IGNORE INTO shields (block, log_index, tx, time, asset, amount, from_address) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const s of batch.shields) shield.run(s.block, s.logIndex, s.tx.toLowerCase(), s.time, s.asset.toLowerCase(), s.amount.toString(), s.from.toLowerCase());
      const unshield = db.prepare<unknown, [number, number, string, number, string, string, string, string, string]>(
        "INSERT OR IGNORE INTO unshields (block, log_index, tx, time, asset, recipient, amount, relayer, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const u of batch.unshields) unshield.run(u.block, u.logIndex, u.tx.toLowerCase(), u.time, u.asset.toLowerCase(), u.recipient.toLowerCase(), u.amount.toString(), u.relayer.toLowerCase(), u.fee.toString());
      const created = db.prepare<unknown, [number, string, string, string, number, number]>("INSERT OR IGNORE INTO markets_created (market, creator, tier, bond, block, time) VALUES (?, ?, ?, ?, ?, ?)");
      for (const m of batch.marketsCreated) created.run(m.market, m.creator.toLowerCase(), m.tier.toString(), m.bond.toString(), m.block, m.time);
      const wallet = db.prepare<unknown, [string, number, number, string]>(
        `INSERT INTO wallets (address, first_block, first_time, first_source) VALUES (?, ?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET first_block = excluded.first_block, first_time = excluded.first_time, first_source = excluded.first_source
         WHERE excluded.first_block < wallets.first_block`,
      );
      for (const w of batch.wallets) wallet.run(w.address.toLowerCase(), w.block, w.time, w.source);
      const event = db.prepare<unknown, [number, string, number, number, number]>(
        `INSERT INTO event_counts (hour, kind, n, first_block, last_block, last_time) VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT (hour, kind) DO UPDATE SET n = n + 1, first_block = MIN(first_block, excluded.first_block),
         last_block = MAX(last_block, excluded.last_block), last_time = MAX(last_time, excluded.last_time)`,
      );
      for (const e of batch.events) event.run(hourOf(e.time), e.kind, e.block, e.block, e.time);
      const sample = db.prepare<unknown, [number, string, string, string, number]>("INSERT OR IGNORE INTO oracle_gas (hour, feed, from_address, fee_wei, block) VALUES (?, ?, ?, ?, ?)");
      for (const o of batch.oracleGas) sample.run(o.hour, o.feed.toLowerCase(), o.from.toLowerCase(), o.feeWei.toString(), o.block);
      const price = db.prepare<unknown, [number, string, string, number, number, number]>(
        `INSERT INTO oracle_prices (hour, feed, answer, updated_at, block, log_index) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (hour, feed) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at, block = excluded.block, log_index = excluded.log_index
         WHERE (excluded.block, excluded.log_index) > (oracle_prices.block, oracle_prices.log_index)`,
      );
      for (const p of batch.prices) price.run(hourOf(p.updatedAt), p.feed.toLowerCase(), p.answer.toString(), p.updatedAt, p.block, p.logIndex);
      db.run("INSERT INTO cursor (id, block, block_hash) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET block = excluded.block, block_hash = excluded.block_hash", [range.to, range.hash.toLowerCase()]);
    })();
  }

  /**
   * The block to roll back to so that `target` and everything after it can be re-indexed exactly. Hourly counts cannot
   * subtract single logs, so every hour touched past `target` is dropped whole, and the rollback goes back to just
   * before that hour's first counted block. Block time only moves forward, so earlier hours hold only earlier blocks.
   */
  rollbackPoint(target: number): number {
    const hour = this.db.query<{ hour: number | null }, [number]>("SELECT MIN(hour) AS hour FROM event_counts WHERE last_block > ?").get(target)?.hour ?? null;
    if (hour === null) return target;
    const first = this.db.query<{ first: number }, [number]>("SELECT MIN(first_block) AS first FROM event_counts WHERE hour >= ?").get(hour)!.first;
    return Math.min(target, first - 1);
  }

  /** Drops everything indexed after `to` and puts the cursor there. A null cursor restarts the index from the deployment block. */
  rollback(to: number, cursor: Cursor | null): void {
    const db = this.db;
    db.transaction(() => {
      const hour = db.query<{ hour: number | null }, [number]>("SELECT MIN(hour) AS hour FROM event_counts WHERE last_block > ?").get(to)?.hour ?? null;
      if (hour !== null) {
        db.run("DELETE FROM event_counts WHERE hour >= ?", [hour]);
        db.run("DELETE FROM oracle_gas WHERE hour >= ?", [hour]);
        db.run("DELETE FROM oracle_prices WHERE hour >= ?", [hour]);
      }
      db.run("DELETE FROM oracle_gas WHERE block > ?", [to]);
      db.run("DELETE FROM oracle_prices WHERE block > ?", [to]);
      db.run("DELETE FROM blocks WHERE number > ?", [to]);
      for (const table of ["txs", "shields", "unshields", "markets_created"] as const) db.run(`DELETE FROM ${table} WHERE block > ?`, [to]);
      db.run("DELETE FROM wallets WHERE first_block > ?", [to]);
      if (cursor) db.run("INSERT INTO cursor (id, block, block_hash) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET block = excluded.block, block_hash = excluded.block_hash", [cursor.block, cursor.hash.toLowerCase()]);
      else db.run("DELETE FROM cursor");
    })();
  }

  recordPageview(p: PageviewRecord): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO pageviews (hour, site, route, referrer_host, device, views, visits) VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (hour, site, route, referrer_host, device) DO UPDATE SET views = views + 1, visits = visits + excluded.visits`,
        [p.hour, p.site, p.route, this.storedReferrer(p.hour, p.referrerHost), p.device, p.visit ? 1 : 0],
      );
    })();
  }

  private storedReferrer(hour: number, host: string | null): string {
    if (host === null) return "";
    if (this.db.query<{ one: number }, [number, string]>("SELECT 1 AS one FROM pageviews WHERE hour = ? AND referrer_host = ? LIMIT 1").get(hour, host)) return host;
    const distinct = this.db
      .query<{ n: number }, [number, string]>("SELECT COUNT(DISTINCT referrer_host) AS n FROM pageviews WHERE hour = ? AND referrer_host NOT IN ('', ?)")
      .get(hour, OTHER_REFERRER)!.n;
    return distinct < REFERRERS_PER_HOUR ? host : OTHER_REFERRER;
  }

  createdMarketIds(): number[] {
    return this.db.query<{ market: number }, []>("SELECT market FROM markets_created ORDER BY market").all().map((r) => r.market);
  }

  marketsCreatedCount(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM markets_created").get()!.n;
  }

  /** Every asset seen in a shield or unshield, so their token details can be loaded. */
  flowAssets(): string[] {
    return this.db.query<{ asset: string }, []>("SELECT asset FROM shields UNION SELECT asset FROM unshields").all().map((r) => r.asset);
  }

  walletCount(since: number, exclude: readonly string[]): number {
    return this.db.query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) AS n FROM wallets WHERE first_time >= ? AND address NOT IN (${placeholders(exclude.length)})`).get(since, ...lower(exclude))!.n;
  }

  walletsPerBucket(since: number, size: number, exclude: readonly string[]): BucketCount[] {
    return this.db
      .query<BucketCount, (string | number)[]>(`SELECT (first_time / ?) * ? AS t, COUNT(*) AS n FROM wallets WHERE first_time >= ? AND address NOT IN (${placeholders(exclude.length)}) GROUP BY t ORDER BY t`)
      .all(size, size, since, ...lower(exclude));
  }

  walletsBySource(exclude: readonly string[]): { source: WalletSource; n: number }[] {
    return this.db
      .query<{ source: WalletSource; n: number }, string[]>(`SELECT first_source AS source, COUNT(*) AS n FROM wallets WHERE address NOT IN (${placeholders(exclude.length)}) GROUP BY first_source ORDER BY n DESC, source`)
      .all(...lower(exclude));
  }

  txCategoryCounts(since: number): CategoryCount[] {
    return this.db.query<CategoryCount, [number]>("SELECT category, COUNT(*) AS n, SUM(status = 0) AS reverted FROM txs WHERE time >= ? GROUP BY category").all(since);
  }

  actionCounts(since: number): ActionCount[] {
    return this.db
      .query<ActionCount, [number]>("SELECT action, category, COUNT(*) AS n, SUM(status = 0) AS reverted FROM txs WHERE time >= ? GROUP BY action, category ORDER BY n DESC, action")
      .all(since);
  }

  txSeries(since: number, size: number, category: Exclude<TxCategory, "oracle">): BucketCount[] {
    return this.db
      .query<BucketCount, [number, number, number, string]>("SELECT (time / ?) * ? AS t, COUNT(*) AS n FROM txs WHERE time >= ? AND category = ? GROUP BY t ORDER BY t")
      .all(size, size, since, category);
  }

  /** Event totals since `since`, by kind, for kinds starting with `prefix`. Counts are hourly, so `since` rounds down to its hour. */
  eventTotals(since: number, prefix: string): { kind: string; n: number }[] {
    return this.db
      .query<{ kind: string; n: number }, [number, string]>("SELECT kind, SUM(n) AS n FROM event_counts WHERE hour >= ?1 AND substr(kind, 1, length(?2)) = ?2 GROUP BY kind")
      .all(hourOf(since), prefix);
  }

  eventSeries(since: number, size: number, prefix: string): BucketCount[] {
    return this.db
      .query<BucketCount, [number, number, string]>("SELECT (hour / ?1) * ?1 AS t, SUM(n) AS n FROM event_counts WHERE hour >= ?2 AND substr(kind, 1, length(?3)) = ?3 GROUP BY t ORDER BY t")
      .all(size, hourOf(since), prefix);
  }

  shieldAmounts(since: number): AmountRow[] {
    return this.db.query<AmountRow, [number]>("SELECT time, asset, amount FROM shields WHERE time >= ? ORDER BY block, log_index").all(since);
  }

  unshieldAmounts(since: number): UnshieldAmountRow[] {
    return this.db.query<UnshieldAmountRow, [number]>("SELECT time, asset, amount, fee FROM unshields WHERE time >= ? ORDER BY block, log_index").all(since);
  }

  operatorActions(senders: readonly string[], since: number): OperatorActionCount[] {
    if (senders.length === 0) return [];
    return this.db
      .query<OperatorActionCount, (string | number)[]>(`SELECT from_address AS "from", action, COUNT(*) AS n FROM txs WHERE time >= ? AND from_address IN (${placeholders(senders.length)}) GROUP BY from_address, action ORDER BY n DESC, action`)
      .all(since, ...lower(senders));
  }

  operatorTotals(senders: readonly string[]): OperatorTxTotals[] {
    if (senders.length === 0) return [];
    return this.db
      .query<OperatorTxTotals, string[]>(`SELECT from_address AS "from", COUNT(*) AS n, MAX(time) AS last FROM txs WHERE from_address IN (${placeholders(senders.length)}) GROUP BY from_address`)
      .all(...lower(senders));
  }

  /** Exact gas per sender over indexed transactions, summed as bigints because single fees can pass 2^53 wei. */
  operatorFees(senders: readonly string[], since: number): Map<string, bigint> {
    const fees = new Map<string, bigint>();
    if (senders.length === 0) return fees;
    const rows = this.db.query<{ from: string; fee_wei: string }, (string | number)[]>(`SELECT from_address AS "from", fee_wei FROM txs WHERE time >= ? AND from_address IN (${placeholders(senders.length)})`).all(since, ...lower(senders));
    for (const r of rows) fees.set(r.from, (fees.get(r.from) ?? 0n) + BigInt(r.fee_wei));
    return fees;
  }

  /** Oracle writes are counted from their events, not fetched one by one; their gas is the hour's sampled fee times the count. */
  oracleWrites(since: number): OracleWrites[] {
    const rows = this.db
      .query<{ from: string; fee_wei: string; n: number; last: number }, [number]>(
        `SELECT o.from_address AS "from", o.fee_wei, e.n, e.last_time AS last FROM oracle_gas o
         JOIN event_counts e ON e.hour = o.hour AND e.kind = 'AnswerUpdated:' || o.feed WHERE o.hour >= ?`,
      )
      .all(hourOf(since));
    const bySender = new Map<string, { feeWei: bigint; n: number; last: number }>();
    for (const r of rows) {
      const acc = bySender.get(r.from) ?? { feeWei: 0n, n: 0, last: 0 };
      bySender.set(r.from, { feeWei: acc.feeWei + BigInt(r.fee_wei) * BigInt(r.n), n: acc.n + r.n, last: Math.max(acc.last, r.last) });
    }
    return [...bySender].map(([from, v]) => ({ from, ...v }));
  }

  /** Last oracle answer per feed per hour, oldest first. Small: one row per feed-hour with an update. */
  oraclePrices(): HourlyPrice[] {
    return this.db.query<HourlyPrice, []>("SELECT hour, feed, answer FROM oracle_prices ORDER BY feed, hour").all();
  }

  /** Per-bucket counts of each action in a category. */
  actionSeries(since: number, size: number, category: Exclude<TxCategory, "oracle">): ActionBucketCount[] {
    return this.db
      .query<ActionBucketCount, [number, number, number, string]>("SELECT action, (time / ?) * ? AS t, COUNT(*) AS n FROM txs WHERE time >= ? AND category = ? GROUP BY action, t ORDER BY action, t")
      .all(size, size, since, category);
  }

  /**
   * Distinct public wallets seen doing something per bucket. A sighting is what fills the wallets table: a shield
   * sender, an unshield recipient, a market creator, or the sender of one of `walletActions`.
   */
  activeWalletsPerBucket(since: number, size: number, walletActions: readonly string[], exclude: readonly string[]): BucketCount[] {
    const { sql, params } = activity(since, walletActions, exclude);
    return this.db.query<BucketCount, (string | number)[]>(`${sql} SELECT (time / ?) * ? AS t, COUNT(DISTINCT address) AS n FROM activity GROUP BY t ORDER BY t`).all(...params, size, size);
  }

  activeWallets(since: number, walletActions: readonly string[], exclude: readonly string[]): ActiveWallets {
    const { sql, params } = activity(since, walletActions, exclude);
    return this.db
      .query<ActiveWallets, (string | number)[]>(
        `${sql} SELECT COUNT(*) AS active, COALESCE(SUM(w.first_time >= ?), 0) AS fresh FROM (SELECT DISTINCT address FROM activity) a JOIN wallets w ON w.address = a.address`,
      )
      .get(...params, since)!;
  }

  /** Shield senders that never received an unshield at any time. */
  stillShielded(exclude: readonly string[]): number {
    const skip = [ZERO_ADDRESS, ...lower(exclude)];
    return this.db
      .query<{ n: number }, string[]>(
        `SELECT COUNT(*) AS n FROM (SELECT DISTINCT from_address AS address FROM shields) s
         WHERE s.address NOT IN (${placeholders(skip.length)}) AND NOT EXISTS (SELECT 1 FROM unshields u WHERE u.recipient = s.address)`,
      )
      .get(...skip)!.n;
  }

  /** Our gas per bucket: exact fees of indexed transactions plus each hour's sampled oracle fee times its writes. */
  operatorFeeSeries(senders: readonly string[], since: number, size: number): Map<number, bigint> {
    const series = new Map<number, bigint>();
    if (senders.length === 0) return series;
    const add = (t: number, wei: bigint): void => {
      series.set(t, (series.get(t) ?? 0n) + wei);
    };
    const txs = this.db
      .query<{ t: number; fee_wei: string }, (string | number)[]>(`SELECT (time / ?) * ? AS t, fee_wei FROM txs WHERE time >= ? AND from_address IN (${placeholders(senders.length)})`)
      .all(size, size, since, ...lower(senders));
    for (const r of txs) add(r.t, BigInt(r.fee_wei));
    const oracle = this.db
      .query<{ t: number; fee_wei: string; n: number }, (string | number)[]>(
        `SELECT (o.hour / ?) * ? AS t, o.fee_wei, e.n FROM oracle_gas o JOIN event_counts e ON e.hour = o.hour AND e.kind = 'AnswerUpdated:' || o.feed
         WHERE o.hour >= ? AND o.from_address IN (${placeholders(senders.length)})`,
      )
      .all(size, size, hourOf(since), ...lower(senders));
    for (const r of oracle) add(r.t, BigInt(r.fee_wei) * BigInt(r.n));
    return series;
  }

  pageviewSeries(since: number, size: number): TrafficBucket[] {
    return this.db
      .query<TrafficBucket, [number, number, number]>("SELECT (hour / ?) * ? AS t, SUM(views) AS views, SUM(visits) AS visits FROM pageviews WHERE hour >= ? GROUP BY t ORDER BY t")
      .all(size, size, hourOf(since));
  }

  /** Routes, devices and sites are closed sets. Referrers are capped at REFERRER_ROWS, with the rest summed as "other". */
  pageviewTotals(since: number, by: TrafficDimension): TrafficCount[] {
    const sql = `SELECT ${TRAFFIC_KEY[by]} AS key, SUM(views) AS views, SUM(visits) AS visits FROM pageviews WHERE hour >= ?1 GROUP BY key ORDER BY views DESC, key`;
    if (by !== "referrer") return this.db.query<TrafficCount, [number]>(sql).all(hourOf(since));
    const top = this.db.query<TrafficCount, [number, number]>(`${sql} LIMIT ?2`).all(hourOf(since), REFERRER_ROWS).filter((r) => r.key !== OTHER_KEY);
    const all = this.db.query<{ views: number; visits: number }, [number]>("SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(visits), 0) AS visits FROM pageviews WHERE hour >= ?").get(hourOf(since))!;
    const rest = { key: OTHER_KEY, views: all.views - top.reduce((n, r) => n + r.views, 0), visits: all.visits - top.reduce((n, r) => n + r.visits, 0) };
    return rest.views > 0 ? [...top, rest] : top;
  }
}

const lower = (addresses: readonly string[]): string[] => addresses.map((a) => a.toLowerCase());

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A CTE of (address, time) wallet sightings since `since`, without the zero address and `exclude`. */
function activity(since: number, walletActions: readonly string[], exclude: readonly string[]): { sql: string; params: (string | number)[] } {
  const skip = [ZERO_ADDRESS, ...lower(exclude)];
  const actions = walletActions.length > 0 ? `action IN (${placeholders(walletActions.length)})` : "0";
  const sql = `WITH activity (address, time) AS (
    SELECT address, time FROM (
      SELECT from_address AS address, time FROM shields WHERE time >= ?
      UNION ALL SELECT recipient, time FROM unshields WHERE time >= ?
      UNION ALL SELECT creator, time FROM markets_created WHERE time >= ?
      UNION ALL SELECT from_address, time FROM txs WHERE time >= ? AND ${actions}
    ) WHERE address NOT IN (${placeholders(skip.length)})
  )`;
  return { sql, params: [since, since, since, since, ...walletActions, ...skip] };
}
