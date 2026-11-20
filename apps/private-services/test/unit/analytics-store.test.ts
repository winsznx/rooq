import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Hex } from "viem";
import { cumulative, denseSeries, parseWindow } from "../../src/lib/analytics-series";
import { AnalyticsStore, REFERRER_ROWS, REFERRERS_PER_HOUR, type IndexBatch, type TxRow } from "../../src/lib/analytics-store";

const H0 = 1_800_000_000 - (1_800_000_000 % 86_400);
const USER = "0x364d832497792553BEE55c531344510B8Ca52657";
const DEPLOYER = "0xc1207E46F4F5322033685131a0E2640f2D3324da";
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const EMPTY: IndexBatch = { blocks: [], txs: [], shields: [], unshields: [], marketsCreated: [], wallets: [], events: [], oracleGas: [], prices: [] };

const tx = (n: number, time: number, over: Partial<TxRow> = {}): TxRow => ({
  hash: hash(n), block: n, time, from: USER, to: null, selector: "0xc46c36b3", action: "shield", category: "user", gasUsed: 100_000n, effectiveGasPrice: 10_000_000n, reverted: false, ...over,
});

describe("schema", () => {
  test("migrations are idempotent across reopen, in WAL mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "rooq-analytics-"));
    const path = join(dir, "nested", "analytics.db");
    new AnalyticsStore(path).close();
    const again = new AnalyticsStore(path);
    again.recordPageview({ hour: H0, site: "web", route: "/", referrerHost: null, device: "mobile", visit: true });
    again.close();
    const raw = new Database(path, { readonly: true });
    expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a changed source fingerprint clears the chain index but keeps pageviews", () => {
    const store = new AnalyticsStore(":memory:");
    expect(store.ensureSource("a")).toBe(false);
    store.commit({ ...EMPTY, txs: [tx(10, H0)] }, { from: 1, to: 10, hash: hash(10) });
    store.recordPageview({ hour: H0, site: "web", route: "/", referrerHost: null, device: "mobile", visit: true });
    expect(store.ensureSource("a")).toBe(false);
    expect(store.ensureSource("b")).toBe(true);
    expect(store.cursor()).toBeNull();
    expect(store.txCategoryCounts(0)).toEqual([]);
    expect(store.pageviewTotals(0, "site")).toEqual([{ key: "web", views: 1, visits: 1 }]);
    store.close();
  });
});

describe("commits", () => {
  test("a range must start right after the cursor, so counts are never applied twice", () => {
    const store = new AnalyticsStore(":memory:");
    store.commit(EMPTY, { from: 1, to: 10, hash: hash(10) });
    expect(() => store.commit(EMPTY, { from: 5, to: 20, hash: hash(20) })).toThrow("cursor is at 10");
    expect(() => store.commit(EMPTY, { from: 12, to: 20, hash: hash(20) })).toThrow("cursor is at 10");
    store.commit(EMPTY, { from: 11, to: 20, hash: hash(20) });
    expect(store.cursor()).toEqual({ block: 20, hash: hash(20) });
    store.close();
  });

  test("event sightings aggregate per hour and kind", () => {
    const store = new AnalyticsStore(":memory:");
    store.commit({ ...EMPTY, events: [{ kind: "PairOpened:1", block: 3, time: H0 + 10 }, { kind: "PairOpened:1", block: 4, time: H0 + 20 }, { kind: "PairOpened:2", block: 5, time: H0 + 3_700 }] }, { from: 1, to: 5, hash: hash(5) });
    store.commit({ ...EMPTY, events: [{ kind: "PairOpened:1", block: 6, time: H0 + 3_800 }, { kind: "RootUpdated", block: 6, time: H0 + 3_800 }] }, { from: 6, to: 6, hash: hash(6) });
    expect(store.eventTotals(0, "PairOpened:").sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([{ kind: "PairOpened:1", n: 3 }, { kind: "PairOpened:2", n: 1 }]);
    expect(store.eventTotals(H0 + 3_650, "PairOpened:").sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([{ kind: "PairOpened:1", n: 1 }, { kind: "PairOpened:2", n: 1 }]);
    expect(store.eventSeries(0, 3_600, "PairOpened:")).toEqual([{ t: H0, n: 2 }, { t: H0 + 3_600, n: 2 }]);
    store.close();
  });

  test("a wallet keeps its earliest sighting whatever order sightings arrive in", () => {
    const store = new AnalyticsStore(":memory:");
    store.commit({ ...EMPTY, wallets: [{ address: USER, block: 9, time: H0 + 900, source: "direct" }, { address: USER.toLowerCase(), block: 4, time: H0 + 400, source: "shield" }] }, { from: 1, to: 10, hash: hash(10) });
    expect(store.walletsBySource([])).toEqual([{ source: "shield", n: 1 }]);
    expect(store.walletsPerBucket(0, 3_600, [])).toEqual([{ t: H0, n: 1 }]);
    store.close();
  });

  test("wallet counts leave out operators, matched case-insensitively", () => {
    const store = new AnalyticsStore(":memory:");
    store.commit({ ...EMPTY, wallets: [{ address: USER, block: 2, time: H0, source: "shield" }, { address: DEPLOYER, block: 3, time: H0 + 86_400, source: "shield" }] }, { from: 1, to: 10, hash: hash(10) });
    expect(store.walletCount(0, [])).toBe(2);
    expect(store.walletCount(0, [DEPLOYER])).toBe(1);
    expect(store.walletCount(H0 + 1, [])).toBe(1);
    expect(store.walletCount(H0 + 1, [DEPLOYER.toUpperCase().replace("0X", "0x")])).toBe(0);
    store.close();
  });

  test("tx counts by category and action, with reverts, over a time window", () => {
    const store = new AnalyticsStore(":memory:");
    const txs = [
      tx(1, H0), tx(2, H0 + 4_000, { action: "processQueue", category: "maintenance", from: DEPLOYER }), tx(3, H0 + 4_100, { action: "processQueue", category: "maintenance", from: DEPLOYER, reverted: true }),
    ];
    store.commit({ ...EMPTY, txs }, { from: 1, to: 3, hash: hash(3) });
    expect(store.txCategoryCounts(0).sort((a, b) => a.category.localeCompare(b.category))).toEqual([{ category: "maintenance", n: 2, reverted: 1 }, { category: "user", n: 1, reverted: 0 }]);
    expect(store.actionCounts(H0 + 1)).toEqual([{ action: "processQueue", category: "maintenance", n: 2, reverted: 1 }]);
    expect(store.txSeries(0, 3_600, "maintenance")).toEqual([{ t: H0 + 3_600, n: 2 }]);
    expect(store.operatorFees([DEPLOYER], 0).get(DEPLOYER.toLowerCase())).toBe(2n * 100_000n * 10_000_000n);
    expect(store.operatorTotals([DEPLOYER])).toEqual([{ from: DEPLOYER.toLowerCase(), n: 2, last: H0 + 4_100 }]);
    store.close();
  });

  test("oracle gas is the hour's sampled fee times that hour's writes, per sender", () => {
    const store = new AnalyticsStore(":memory:");
    const feed = "0x6266a7d494fD35aEC096aBf2De04c2A814220BDf";
    const events = [0, 1, 2].map((i) => ({ kind: `AnswerUpdated:${feed.toLowerCase()}`, block: 10 + i, time: H0 + i * 60 }));
    store.commit({ ...EMPTY, events, oracleGas: [{ hour: H0, feed, from: DEPLOYER, feeWei: 7n, block: 10 }] }, { from: 1, to: 12, hash: hash(12) });
    expect(store.oracleWrites(0)).toEqual([{ from: DEPLOYER.toLowerCase(), feeWei: 21n, n: 3, last: H0 + 120 }]);
    expect(store.hasOracleSample(H0, feed)).toBe(true);
    store.close();
  });

  test("amounts above 2^53 are kept exactly", () => {
    const store = new AnalyticsStore(":memory:");
    const amount = 123_456_789n * 10n ** 18n;
    store.commit({ ...EMPTY, shields: [{ block: 2, logIndex: 0, tx: hash(2), time: H0, asset: USER, amount, from: USER }] }, { from: 1, to: 2, hash: hash(2) });
    expect(store.shieldAmounts(0)[0]?.amount).toBe(amount.toString());
    store.close();
  });

  test("a pageview upsert adds views and only first-of-day visits", () => {
    const store = new AnalyticsStore(":memory:");
    const view = { hour: H0, site: "web" as const, route: "/app", referrerHost: "x.com", device: "mobile" as const, visit: true };
    store.recordPageview(view);
    store.recordPageview({ ...view, visit: false });
    store.recordPageview({ ...view, device: "desktop" });
    expect(store.pageviewTotals(0, "device")).toEqual([{ key: "mobile", views: 2, visits: 1 }, { key: "desktop", views: 1, visits: 1 }]);
    expect(store.pageviewTotals(0, "route")).toEqual([{ key: "web:/app", views: 3, visits: 2 }]);
    store.close();
  });
});

describe("referrer cardinality", () => {
  const view = { hour: H0, site: "web" as const, route: "/", device: "desktop" as const, visit: false };

  test("each hour keeps a bounded number of referrer hosts and files the rest as other", () => {
    const store = new AnalyticsStore(":memory:");
    for (let i = 0; i < REFERRERS_PER_HOUR + 5; i++) store.recordPageview({ ...view, referrerHost: `spam${i}.example` });
    store.recordPageview({ ...view, referrerHost: "spam0.example" });
    store.recordPageview({ ...view, referrerHost: null });
    store.recordPageview({ ...view, hour: H0 + 3_600, referrerHost: "late.example" });
    const rows = store.pageviewTotals(0, "referrer");
    expect(rows.find((r) => r.key === "spam0.example")?.views).toBe(2);
    expect(rows.find((r) => r.key === "late.example")?.views).toBe(1);
    expect(rows.filter((r) => r.key.endsWith(".example")).length).toBeLessThanOrEqual(REFERRER_ROWS);
    expect(rows.reduce((n, r) => n + r.views, 0)).toBe(REFERRERS_PER_HOUR + 8);
    expect(rows.find((r) => r.key === "direct")?.views).toBe(1);
    store.close();
  });

  test("a traffic response lists at most REFERRER_ROWS hosts and sums the rest as other", () => {
    const store = new AnalyticsStore(":memory:");
    for (let h = 0; h < 3; h++) for (let i = 0; i < 30; i++) store.recordPageview({ ...view, hour: H0 + h * 3_600, referrerHost: `h${h}-${i}.example` });
    const rows = store.pageviewTotals(0, "referrer");
    expect(rows.length).toBe(REFERRER_ROWS + 1);
    expect(rows.at(-1)).toEqual({ key: "other", views: 90 - REFERRER_ROWS, visits: 0 });
    expect(rows.reduce((n, r) => n + r.views, 0)).toBe(90);
    store.close();
  });
});

describe("rollback", () => {
  const events = (blocks: [number, number][]): IndexBatch => ({ ...EMPTY, events: blocks.map(([block, time]) => ({ kind: "RootUpdated", block, time })) });

  test("goes back to the first block of the earliest hour touched past the target", () => {
    const store = new AnalyticsStore(":memory:");
    store.commit(events([[10, H0 + 10], [20, H0 + 3_610], [25, H0 + 3_700], [30, H0 + 7_300]]), { from: 1, to: 30, hash: hash(30) });
    expect(store.rollbackPoint(22)).toBe(19);
    expect(store.rollbackPoint(30)).toBe(30);
    expect(store.rollbackPoint(5)).toBe(5);
  });

  test("drops the touched hours whole and every row past the point, then re-counts exactly", () => {
    const store = new AnalyticsStore(":memory:");
    store.commit({ ...events([[10, H0 + 10], [20, H0 + 3_610], [25, H0 + 3_700]]), txs: [tx(20, H0 + 3_610)], wallets: [{ address: USER, block: 25, time: H0 + 3_700, source: "direct" }] }, { from: 1, to: 30, hash: hash(30) });
    const to = store.rollbackPoint(22);
    store.rollback(to, { block: to, hash: hash(to) });
    expect(store.cursor()).toEqual({ block: 19, hash: hash(19) });
    expect(store.eventTotals(0, "RootUpdated")).toEqual([{ kind: "RootUpdated", n: 1 }]);
    expect(store.hasTx(hash(20))).toBe(false);
    expect(store.walletCount(0, [])).toBe(0);
    store.commit(events([[20, H0 + 3_610], [26, H0 + 3_720]]), { from: 20, to: 30, hash: hash(31) });
    expect(store.eventSeries(0, 3_600, "RootUpdated")).toEqual([{ t: H0, n: 1 }, { t: H0 + 3_600, n: 2 }]);
  });

  test("a null cursor restarts from the deployment block", () => {
    const store = new AnalyticsStore(":memory:");
    store.commit(events([[10, H0]]), { from: 1, to: 10, hash: hash(10) });
    store.rollback(0, null);
    expect(store.cursor()).toBeNull();
    expect(store.eventTotals(0, "")).toEqual([]);
  });
});

describe("windows and series", () => {
  const NOW = H0 + 5 * 86_400 + 1_234;

  test("defaults to hourly up to a week and daily beyond", () => {
    expect(parseWindow(new URL("http://x/"), NOW)).toEqual({ range: "7d", bucket: "hour", since: NOW - 1_234 - 7 * 86_400, now: NOW });
    expect(parseWindow(new URL("http://x/?range=30d"), NOW).bucket).toBe("day");
    expect(parseWindow(new URL("http://x/?range=all&bucket=hour"), NOW).since).toBe(0);
  });

  test("starts on a bucket boundary, so hourly counts and exact timestamps cover the same span", () => {
    expect(parseWindow(new URL("http://x/?range=24h"), NOW).since).toBe(H0 + 4 * 86_400);
    expect(parseWindow(new URL("http://x/?range=30d&bucket=day"), NOW).since).toBe(H0 + 5 * 86_400 - 30 * 86_400);
  });

  test("refuses an unknown range or bucket", () => {
    expect(() => parseWindow(new URL("http://x/?range=1y"), NOW)).toThrow("range must be one of");
    expect(() => parseWindow(new URL("http://x/?bucket=minute"), NOW)).toThrow("bucket must be one of");
  });

  test("fills empty buckets with zero from the window start to now", () => {
    const w = parseWindow(new URL("http://x/?range=7d&bucket=day"), NOW);
    const series = denseSeries([{ t: H0 + 86_400 + 5, n: 2 }, { t: H0 + 86_400 + 50, n: 1 }], w);
    expect(series.length).toBe(8);
    expect(series.find((p) => p.t === H0 + 86_400)?.v).toBe(3);
    expect(series.reduce((s, p) => s + p.v, 0)).toBe(3);
    expect(series.at(-1)?.t).toBe(H0 + 5 * 86_400);
  });

  test("an all-time series starts at the given first point", () => {
    const w = parseWindow(new URL("http://x/?range=all&bucket=day"), NOW);
    expect(denseSeries([], w, H0 + 3 * 86_400).map((p) => p.t)).toEqual([H0 + 3 * 86_400, H0 + 4 * 86_400, H0 + 5 * 86_400]);
    expect(denseSeries([], w)).toEqual([{ t: H0 + 5 * 86_400, v: 0 }]);
  });

  test("refuses hourly buckets over a range too long to draw", () => {
    const w = parseWindow(new URL("http://x/?range=all&bucket=hour"), NOW);
    expect(() => denseSeries([], w, NOW - 200 * 86_400)).toThrow("use bucket=day");
  });

  test("a running total starts from what came before", () => {
    expect(cumulative([{ t: 0, v: 1 }, { t: 1, v: 0 }, { t: 2, v: 2 }], 5)).toEqual([{ t: 0, v: 6 }, { t: 1, v: 6 }, { t: 2, v: 8 }]);
  });
});
