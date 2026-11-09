import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { activityRow, describe as describeEvent, precisionFor, type ActivityContext, type ActivitySource } from "../src/activity";
import { parseInterval, toCandles } from "../src/candles";
import { computeIndexerHealth, type StatusRow } from "../src/history";
import { matchRoute } from "../src/routes";
import { parseLastEventId, sseFrame, toEnvelope } from "../src/stream";

const NOW = Date.parse("2026-11-07T18:00:00Z");
const limits = { staleSeconds: 30, maxLagBlocks: 5 };
const row = (patch: Partial<StatusRow> = {}): StatusRow => ({
  status: "ok",
  reason: null,
  last_indexed_block: 100n,
  head_block: 100n,
  last_reconciled_block: 95n,
  updated_at: new Date(NOW - 2_000),
  ...patch,
});

describe("computeIndexerHealth", () => {
  test("is down when the indexer never wrote a status row", () => {
    expect(computeIndexerHealth(null, 100n, NOW, limits).status).toBe("down");
  });

  test("is down when the heartbeat is older than the limit, even if the row says ok", () => {
    const health = computeIndexerHealth(row({ updated_at: new Date(NOW - 31_000) }), 100n, NOW, limits);
    expect([health.status, health.reason]).toEqual(["down", "no indexer heartbeat for 31s"]);
  });

  test("passes a degraded reason through", () => {
    const health = computeIndexerHealth(row({ status: "degraded", reason: "reconciliation mismatch at block 90" }), 100n, NOW, limits);
    expect([health.status, health.reason]).toEqual(["degraded", "reconciliation mismatch at block 90"]);
  });

  test("is behind when the RPC head is further ahead than the lag limit", () => {
    const health = computeIndexerHealth(row(), 106n, NOW, limits);
    expect([health.status, health.lagBlocks, health.reason]).toEqual(["behind", 6, "6 blocks behind head"]);
  });

  test("is ok within the lag limit and reports blocks as decimal strings", () => {
    const health = computeIndexerHealth(row(), 103n, NOW, limits);
    expect(health).toEqual({ status: "ok", reason: null, lastIndexedBlock: "100", headBlock: "103", lagBlocks: 3, lastReconciledBlock: "95" });
  });
});

describe("candles", () => {
  test("accepts the six chart intervals and rejects others", () => {
    expect(parseInterval("4h")).toEqual({ interval: "4h", seconds: 14_400 });
    expect(() => parseInterval("2m")).toThrow("interval must be one of 1m, 5m, 15m, 1h, 4h, 1d.");
  });

  test("defaults to 1h", () => {
    expect(parseInterval(null).interval).toBe("1h");
  });

  test("orders buckets oldest first and leaves gaps empty instead of filling them", () => {
    // #given two newest-first buckets three hours apart
    const rows = [
      { t: 10_800n, o: "5", h: "6", l: "4", c: "5", v: "1" },
      { t: 0n, o: "1", h: "2", l: "1", c: "2", v: "3" },
    ];
    // #then exactly two candles, no synthetic ones between them
    expect(toCandles(rows).map((c) => c.t)).toEqual([0, 10_800]);
  });

  test("no executions means no candles", () => {
    expect(toCandles([])).toEqual([]);
  });
});

const WALLET: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const MAKER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const MAKER_WALLET: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TX: Hex = `0x${"cd".repeat(32)}`;
const MARKET: Hex = `0x${"3a".repeat(32)}`;
const COLLATERAL: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const BASE = "0x68b1d87f95878fe05b998f19b66f4baba5de1aed";
const ctx: ActivityContext = {
  wallet: WALLET,
  tokens: new Map([
    [COLLATERAL.toLowerCase(), { symbol: "mUSD", decimals: 6 }],
    [BASE, { symbol: "mTSLA", decimals: 18 }],
  ]),
  collateral: { address: COLLATERAL, symbol: "mUSD", decimals: 6 },
  finality: "local",
};

function source(event_name: string, args: Record<string, unknown>, canonical = true): ActivitySource {
  return {
    block_number: 89n,
    block_timestamp: 1_794_075_000n,
    tx_hash: TX,
    event_name,
    args,
    market_id: MARKET,
    canonical,
    market_base: BASE,
    pool_token0: null,
    pool_token1: null,
  };
}

describe("activity summaries", () => {
  const fill = { taker: WALLET.toLowerCase(), maker: MAKER, sizeDelta: "11016831269995826957", price: "359809450000000000000", fee: "2378376" };

  test("describe a taker's fill from the taker's side", () => {
    expect(describeEvent(source("TradeExecuted", fill), ctx)).toEqual({ action: "perp.trade", summary: "Bought 11.0168 mTSLA perp at 359.81, fee 2.38 mUSD" });
  });

  test("describe the same fill from the maker's side", () => {
    const makerCtx = { ...ctx, wallet: MAKER_WALLET };
    expect(describeEvent(source("TradeExecuted", fill), makerCtx).summary).toBe("Sold as maker 11.0168 mTSLA perp at 359.81");
  });

  test("funding paid by the taker is received by the maker", () => {
    const args = { taker: WALLET.toLowerCase(), maker: MAKER, takerPaid: "278" };
    const makerCtx = { ...ctx, wallet: MAKER_WALLET };
    expect([describeEvent(source("FundingSettled", args), ctx).summary, describeEvent(source("FundingSettled", args), makerCtx).summary]).toEqual([
      "Paid 0.000278 mUSD funding on mTSLA",
      "Received 0.000278 mUSD funding on mTSLA",
    ]);
  });

  test("unreadable args are reported as unknown, not as zero", () => {
    expect(describeEvent(source("Deposited", {}), ctx).summary).toBe("Deposited an unknown amount into the margin vault for an unknown account");
  });

  test("an orphaned event is shown as rechecking rather than hidden", () => {
    const item = activityRow(source("Deposited", { payer: WALLET.toLowerCase(), account: WALLET.toLowerCase(), amount: "600000000" }, false), ctx);
    expect([item.state, item.canonical, item.summary]).toEqual(["rechecking", false, "Deposited 600.00 mUSD into the margin vault for you"]);
  });

  test("precision widens only for non-zero amounts that would round to zero", () => {
    expect([precisionFor(278n, 6, 2), precisionFor(1_000_000n, 6, 2), precisionFor(0n, 6, 2)]).toEqual([6, 2, 2]);
  });
});

describe("stream framing", () => {
  test("data frames carry the stream sequence as the SSE id", () => {
    expect(sseFrame({ a: 1n }, 42n)).toBe('id: 42\ndata: {"a":"1"}\n\n');
  });

  test("frames without a sequence have no id, so they never move Last-Event-ID", () => {
    expect(sseFrame({ type: "indexer.sync" })).toBe('data: {"type":"indexer.sync"}\n\n');
  });

  test("Last-Event-ID must be a sequence number", () => {
    expect([parseLastEventId(null), parseLastEventId("17")]).toEqual([null, 17n]);
    expect(() => parseLastEventId("17; drop")).toThrow();
  });

  test("a reorg tombstone keeps the original event id with reverted set", () => {
    // #given a stream row written when the event's block was orphaned
    const envelope = toEnvelope(31337, {
      seq: 9n,
      type: "pool.swap",
      market_id: null,
      block_number: 142n,
      block_hash: `0x${"b5".repeat(32)}`,
      tx_hash: `0x${"55".repeat(32)}`,
      log_index: 4,
      event_id: "31337:0xb5:4",
      reverted: true,
      payload: { event: "SwapExecuted" },
      observed_at: new Date(NOW),
    });
    // #then
    expect([envelope.type, envelope.eventId, envelope.reverted, envelope.schemaVersion, envelope.blockNumber]).toEqual(["pool.swap", "31337:0xb5:4", true, 1, "142"]);
  });
});

describe("routing", () => {
  test("extracts path parameters under /api/v1", () => {
    const m = matchRoute("GET", `/api/v1/markets/0x${"ab".repeat(32)}/chart`);
    expect(m.route ? m.params : null).toEqual({ marketId: `0x${"ab".repeat(32)}` });
  });

  test("distinguishes a wrong method from an unknown path", () => {
    const wrongMethod = matchRoute("DELETE", "/api/v1/markets");
    const unknown = matchRoute("GET", "/api/v2/markets");
    expect([wrongMethod.route === null && wrongMethod.methodMismatch, unknown.route === null && !unknown.methodMismatch]).toEqual([true, true]);
  });
});
