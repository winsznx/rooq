import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { OperatorBook } from "../../src/lib/analytics-operators";
import { AdminReports } from "../../src/lib/analytics-report";
import { adminRoutes } from "../../src/lib/analytics-routes";
import { parseWindow } from "../../src/lib/analytics-series";
import { AnalyticsStore, type IndexBatch, type TxRow } from "../../src/lib/analytics-store";
import { TokenBook } from "../../src/lib/analytics-tokens";
import { ServiceError } from "../../src/lib/errors";
import { createLogger } from "../../src/lib/log";

const H0 = 1_800_000_000 - (1_800_000_000 % 86_400);
const HOUR = 3_600;
const USDG: Address = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
const TSLA: Address = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";
const FEED: Address = "0x6266a7d494fD35aEC096aBf2De04c2A814220BDf";
const ALICE: Address = "0x364d832497792553BEE55c531344510B8Ca52657";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
const CAROL: Address = "0x00000000000000000000000000000000000ca201";
const DAVE: Address = "0x00000000000000000000000000000000000da7e0";
const RELAYER: Address = "0x109204c94872210cC9D666A284Ba4069c6DE2E55";
const COORDINATOR: Address = "0x0Ec52416Cd54Be1DCed168A1029004FC631E0Ff5";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const USERS = [ALICE, BOB, CAROL, DAVE];
const log = createLogger("analytics-test");
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const EMPTY: IndexBatch = { blocks: [], txs: [], shields: [], unshields: [], marketsCreated: [], wallets: [], events: [], oracleGas: [], prices: [] };
const USD = 1_000_000n;
const TOKEN = 10n ** 18n;

const tx = (n: number, time: number, over: Partial<TxRow> = {}): TxRow => ({
  hash: hash(n), block: n, time, from: ALICE, to: null, selector: "0xc46c36b3", action: "shield", category: "user", gasUsed: 100_000n, effectiveGasPrice: 10n, reverted: false, ...over,
});

/**
 * A day of flows. TSLA's feed answers $250 in hour H0 and $300 in hour H0+2h. DAVE shields 64 USDG 30 hours earlier,
 * which falls in the 24h window's comparison window. CAROL's TSLA shield predates every answer, so it is unpriced.
 */
function seeded(): AnalyticsStore {
  const store = new AnalyticsStore(":memory:");
  const shield = (n: number, time: number, asset: Address, amount: bigint, from: Address) => ({ block: n, logIndex: 0, tx: hash(n), time, asset, amount, from });
  store.commit({
    ...EMPTY,
    prices: [
      { feed: FEED, answer: 240_00000000n, updatedAt: H0 + 10, block: 3, logIndex: 0 },
      { feed: FEED, answer: 250_00000000n, updatedAt: H0 + 100, block: 4, logIndex: 0 },
      { feed: FEED, answer: 300_00000000n, updatedAt: H0 + 2 * HOUR + 10, block: 9, logIndex: 0 },
    ],
    shields: [
      shield(1, H0 - 30 * HOUR, USDG, 64n * USD, DAVE),
      shield(2, H0 - HOUR, TSLA, 1n * TOKEN, CAROL),
      shield(5, H0 + 50, USDG, 100n * USD, ALICE),
      shield(6, H0 + 60, USDG, 10n * USD, DAVE),
      shield(7, H0 + HOUR + 5, TSLA, 2n * TOKEN, BOB),
    ],
    unshields: [{ block: 10, logIndex: 0, tx: hash(10), time: H0 + 2 * HOUR + 100, asset: USDG, recipient: ALICE, amount: 40n * USD, relayer: RELAYER, fee: 1n * USD }],
    txs: [
      tx(5, H0 + 50),
      tx(10, H0 + 2 * HOUR + 100, { from: RELAYER, action: "spend" }),
      tx(11, H0 + 2 * HOUR + 200, { from: COORDINATOR, action: "processQueue", category: "maintenance" }),
      tx(12, H0 + 2 * HOUR + 300, { from: ZERO, action: "spend" }),
    ],
    wallets: [
      { address: DAVE, block: 1, time: H0 - 30 * HOUR, source: "shield" },
      { address: CAROL, block: 2, time: H0 - HOUR, source: "shield" },
      { address: ALICE, block: 5, time: H0 + 50, source: "shield" },
      { address: BOB, block: 7, time: H0 + HOUR + 5, source: "shield" },
      { address: RELAYER, block: 10, time: H0 + 2 * HOUR + 100, source: "direct" },
    ],
  }, { from: 1, to: 20, hash: hash(20) });
  return store;
}

async function reportsOver(store: AnalyticsStore): Promise<AdminReports> {
  const tokens = new TokenBook((a) => Promise.resolve(a === USDG ? { symbol: "USDG", decimals: 6 } : { symbol: "TSLA", decimals: 18 }), log);
  await tokens.load([USDG, TSLA]);
  const operators = new OperatorBook([{ label: "relayer", address: RELAYER }, { label: "coordinator", address: COORDINATOR }], { balance: () => Promise.resolve(0n), nonce: () => Promise.resolve(0) }, 1_000, log);
  return new AdminReports({
    store, operators, tokens,
    indexer: { state: () => ({ indexedBlock: 20, head: 20, lagBlocks: 0, updatedAt: 0, backfilling: false }) },
    services: { snapshot: () => Promise.resolve({ checkedAt: 0, services: [] }) },
    markets: () => [],
    pools: () => [],
    lastPriceAt: () => Promise.resolve(null),
    stableAsset: USDG,
    feeds: () => [{ asset: TSLA, feed: FEED, decimals: 8 }],
    vault: { snapshot: () => Promise.resolve({ asOf: 0, totalUsd: 0, assets: [] }) },
    token: null,
  });
}

const NOW = H0 + 3 * HOUR;
const window = (query: string) => parseWindow(new URL(`http://x/?${query}`), NOW);

describe("oracle prices in the store", () => {
  test("keep the last answer per feed per hour, in log order", () => {
    const store = seeded();
    expect(store.oraclePrices()).toEqual([
      { hour: H0, feed: FEED.toLowerCase(), answer: "25000000000" },
      { hour: H0 + 2 * HOUR, feed: FEED.toLowerCase(), answer: "30000000000" },
    ]);
  });

  test("an earlier log committed later does not replace the hour's answer", () => {
    const store = seeded();
    store.commit({ ...EMPTY, prices: [{ feed: FEED, answer: 1n, updatedAt: H0 + 5, block: 2, logIndex: 0 }] }, { from: 21, to: 21, hash: hash(21) });
    expect(store.oraclePrices()[0]?.answer).toBe("25000000000");
  });

  test("are dropped with the hours a rollback re-indexes", () => {
    const store = seeded();
    store.commit({ ...EMPTY, events: [{ kind: "RootUpdated", block: 9, time: H0 + 2 * HOUR + 10 }] }, { from: 21, to: 21, hash: hash(21) });
    store.rollback(store.rollbackPoint(8), { block: 8, hash: hash(8) });
    expect(store.oraclePrices().map((p) => p.hour)).toEqual([H0]);
  });

  test("are cleared with the rest of the chain index when the source changes", () => {
    const store = seeded();
    store.ensureSource("a");
    expect(store.oraclePrices()).toEqual([]);
  });
});

describe("money", () => {
  test("values shields and unshields at the hour's answer, and counts what had no price", async () => {
    const money = (await reportsOver(seeded())).money(window("range=all&bucket=hour"));
    expect(money.totals).toMatchObject({ allTimeUsd: 714, inRangeUsd: 714, inUsd: 674, outUsd: 40, changePct: null });
    expect(money.unpriced).toBe(1);
    expect(money.byAsset.map((a) => [a.direction, a.symbol, a.amount, a.usd])).toEqual([
      ["in", "TSLA", (3n * TOKEN).toString(), 500],
      ["in", "USDG", (174n * USD).toString(), 174],
      ["out", "USDG", (40n * USD).toString(), 40],
    ]);
  });

  test("compares the window with the previous one of the same length", async () => {
    const money = (await reportsOver(seeded())).money(window("range=24h"));
    expect(money.totals).toMatchObject({ inRangeUsd: 650, last24hUsd: 650, last7dUsd: 714, changePct: 915.63 });
  });

  test("series sum to the in-range totals, in dollars per bucket", async () => {
    const money = (await reportsOver(seeded())).money(window("range=24h"));
    expect(money.series.in.find((p) => p.t === H0)?.v).toBe(110);
    expect(money.series.in.find((p) => p.t === H0 + HOUR)?.v).toBe(500);
    expect(money.series.out.reduce((s, p) => s + p.v, 0)).toBe(40);
  });
});

describe("fees", () => {
  test("relayer fees in dollars against the relayer's and every operator's gas", async () => {
    const fees = (await reportsOver(seeded())).fees(window("range=24h"));
    expect(fees.relayerFees).toEqual([{ asset: USDG, symbol: "USDG", decimals: 6, decimalsKnown: true, amount: USD.toString(), usd: 1 }]);
    expect(fees.relayerFeesUsd).toBe(1);
    expect(fees.relayerGasWei).toBe("1000000");
    expect(fees.operatorGasWei).toBe("2000000");
    expect(fees.operatorGasSeries.find((p) => p.t === H0 + 2 * HOUR)?.v).toBe(2_000_000 / 1e18);
    expect(fees.relayerFeesSeries.reduce((s, p) => s + p.v, 0)).toBe(1);
  });

  test("operator gas per bucket includes each hour's sampled oracle writes", () => {
    const store = seeded();
    store.commit({
      ...EMPTY,
      events: [0, 1].map((i) => ({ kind: `AnswerUpdated:${FEED.toLowerCase()}`, block: 21, time: H0 + i })),
      oracleGas: [{ hour: H0, feed: FEED, from: COORDINATOR, feeWei: 7n, block: 21 }],
    }, { from: 21, to: 21, hash: hash(21) });
    expect(store.operatorFeeSeries([COORDINATOR], 0, 86_400).get(H0)).toBe(1_000_000n + 14n);
  });
});

describe("people", () => {
  test("counts active, new and returning wallets, leaving out operators and the zero address", async () => {
    const people = (await reportsOver(seeded())).people(window("range=24h"));
    expect(people).toMatchObject({ activeInRange: 4, newInRange: 3, returningInRange: 1, stillShielded: 3 });
    expect(people.active.find((p) => p.t === H0)?.v).toBe(2);
    expect(people.active.find((p) => p.t === H0 + 2 * HOUR)?.v).toBe(1);
  });

  test("all time, everyone active is new", async () => {
    expect((await reportsOver(seeded())).people(window("range=all&bucket=day"))).toMatchObject({ activeInRange: 4, newInRange: 4, returningInRange: 0 });
  });
});

describe("kinds", () => {
  test("series per user action, busiest first, with maintenance left out", async () => {
    const kinds = (await reportsOver(seeded())).kinds(window("range=24h"));
    expect(kinds.kinds.map((k) => [k.action, k.series.reduce((s, p) => s + p.v, 0)])).toEqual([["spend", 2], ["shield", 1]]);
    expect(kinds.kinds.every((k) => k.category === "user" && k.series.length === kinds.kinds[0]!.series.length)).toBe(true);
  });
});

describe("new slices", () => {
  test("never return a user address", async () => {
    const reports = await reportsOver(seeded());
    const w = window("range=all&bucket=hour");
    const bodies = JSON.stringify([reports.money(w), reports.fees(w), reports.people(w), reports.kinds(w), await reports.vault()]).toLowerCase();
    for (const user of USERS) expect(bodies).not.toContain(user.toLowerCase());
  });

  test("the token slice answers 503 NOT_CONFIGURED when it isn't configured", async () => {
    const reports = await reportsOver(seeded());
    expect(() => reports.token(window("range=7d"))).toThrow(ServiceError);
    const route = adminRoutes(reports, "t".repeat(64), () => NOW).find((r) => r.pattern === "/v1/admin/token")!;
    const req = new Request("http://x/v1/admin/token", { headers: { authorization: `Bearer ${"t".repeat(64)}` } });
    await expect(Promise.resolve().then(() => route.handler({ req, url: new URL(req.url), params: {} }))).rejects.toMatchObject({ statusCode: 503, reasonCode: "NOT_CONFIGURED" });
  });

  test("every new slice is routed behind the bearer token", async () => {
    const routes = adminRoutes(await reportsOver(seeded()), "t".repeat(64), () => NOW);
    for (const slice of ["money", "vault", "fees", "people", "kinds", "token"]) {
      const route = routes.find((r) => r.pattern === `/v1/admin/${slice}`)!;
      const req = new Request(`http://x/v1/admin/${slice}`);
      await expect(Promise.resolve().then(() => route.handler({ req, url: new URL(req.url), params: {} }))).rejects.toMatchObject({ statusCode: 401 });
    }
  });
});
