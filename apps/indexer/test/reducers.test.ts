import { describe, expect, test } from "bun:test";
import { applyEvents, nextOpenInterest, normalisedAnswer, perpNotional, swapExecution } from "../src/reducers";
import { FREE_DOMAIN, backstopDomain, commitDomain } from "../src/domains";
import { cloneState, emptyState, ledgerKey, positionKey, type DerivedState, type ReduceOutput } from "../src/state";
import type { IndexedEvent } from "../src/decode";
import {
  BACKSTOP,
  BASE,
  COLLATERAL,
  CREATOR,
  Clock,
  DEAD,
  FEED,
  FEED_ID,
  MAKER,
  MARKET,
  POOL,
  TAKER,
  VAULT,
  ZERO,
  ctx,
  feed,
  house,
  json,
  marketCreated,
  oracle,
  pool,
  registry,
  vault,
} from "./fixtures";

const REGISTRY = "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707";
const CH = "0xa513e6e4b8f2a923d98304ec87f64353c4d5c853";
const ORACLE = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const WAD = 10n ** 18n;
const PRICE = 359n * WAD;

function run(build: (clock: Clock) => IndexedEvent[]): { state: DerivedState; out: ReduceOutput } {
  const clock = new Clock();
  const state = emptyState();
  const out = applyEvents(state, build(clock), ctx);
  return { state, out };
}

function status(clock: Clock, from: number, to: number): IndexedEvent {
  return registry(clock.next(REGISTRY, { newBlock: true }), { eventName: "StatusChanged", args: { marketId: MARKET, from, to, by: CREATOR } });
}

function trade(clock: Clock, sizeDelta: bigint, realizedPnl: bigint): IndexedEvent {
  return house(clock.next(CH, { newBlock: true }), {
    eventName: "TradeExecuted",
    args: { marketId: MARKET, taker: TAKER, maker: MAKER, sizeDelta, price: PRICE, markPrice: PRICE, fee: 1_000n, realizedPnl, quoteHash: `0x${"11".repeat(32)}` },
  });
}

function position(clock: Clock, size: bigint, takerMargin: bigint, makerMargin: bigint): IndexedEvent {
  return house(clock.next(CH), {
    eventName: "PositionChanged",
    args: { marketId: MARKET, taker: TAKER, maker: MAKER, size, entryPrice: size === 0n ? 0n : PRICE, takerMargin, makerMargin },
  });
}

describe("market lifecycle reducer", () => {
  const lifecycle = () =>
    run((clock) => [
      ...marketCreated(clock),
      status(clock, 0, 1),
      registry(clock.next(REGISTRY), {
        eventName: "PerpProposed",
        args: { marketId: MARKET, tierId: 4, feedId: FEED_ID, maxOiUsdWad: 40_000n * WAD, version: 1 },
      }),
      status(clock, 1, 2),
      status(clock, 2, 3),
    ]);

  test("ends in the last status with the proposed perp configuration", () => {
    // #given a market created, proposed, activated and moved to close-only
    // #when the events are reduced
    const { state } = lifecycle();
    // #then the market row reflects every step
    const m = state.markets.get(MARKET);
    expect([m?.perpStatus, m?.spotStatus, m?.tierId, m?.feedId, m?.maxOiUsdWad, m?.pool]).toEqual(["CLOSE_ONLY", "ACTIVE", 4, FEED_ID, 40_000n * WAD, POOL]);
  });

  test("links the pool created by the factory to its market", () => {
    // #given / #when
    const { state } = lifecycle();
    // #then
    expect(state.pools.get(POOL)?.marketId).toBe(MARKET);
  });

  test("records each transition as a status event", () => {
    // #given / #when
    const { out } = lifecycle();
    // #then
    expect(out.history.marketStatusEvents.map((s) => `${s.from}->${s.to}`)).toEqual(["NONE->REGISTERED", "REGISTERED->ACTIVE", "ACTIVE->CLOSE_ONLY"]);
  });

  test("flags a transition that does not start from the derived status", () => {
    // #given a market still NONE
    // #when a StatusChanged claims ACTIVE -> CLOSE_ONLY
    const { out } = run((clock) => [...marketCreated(clock), status(clock, 2, 3)]);
    // #then the inconsistency is reported
    expect(out.violations.map((v) => v.message)).toEqual(["status change from ACTIVE but derived status is NONE"]);
  });

  test("refuses events for a market that was never created", () => {
    // #given no MarketCreated
    // #when a status change arrives
    const { state, out } = run((clock) => [status(clock, 0, 1)]);
    // #then nothing is invented and the event is flagged
    expect([state.markets.size, out.violations[0]?.message]).toEqual([0, "event for a market that was never created"]);
  });
});

describe("vault ledger reducer", () => {
  const ledger = () =>
    run((clock) => [
      ...marketCreated(clock),
      vault(clock.next(VAULT, { newBlock: true }), { eventName: "Deposited", args: { payer: MAKER, account: MAKER, amount: 10_000n } }),
      vault(clock.next(VAULT), { eventName: "Moved", args: { fromDomain: FREE_DOMAIN, from: MAKER, toDomain: commitDomain(MARKET), to: MAKER, amount: 6_000n } }),
      house(clock.next(CH), { eventName: "BackingChanged", args: { marketId: MARKET, maker: MAKER, delta: 6_000n, commitTotal: 6_000n } }),
      vault(clock.next(VAULT, { newBlock: true }), { eventName: "Deposited", args: { payer: CREATOR, account: CREATOR, amount: 500n } }),
      vault(clock.next(VAULT), { eventName: "Moved", args: { fromDomain: FREE_DOMAIN, from: CREATOR, toDomain: backstopDomain(MARKET), to: CREATOR, amount: 150n } }),
      vault(clock.next(VAULT), { eventName: "Moved", args: { fromDomain: FREE_DOMAIN, from: CREATOR, toDomain: backstopDomain(MARKET), to: BACKSTOP, amount: 50n } }),
      vault(clock.next(VAULT, { newBlock: true }), { eventName: "Withdrawn", args: { account: MAKER, to: MAKER, amount: 4_000n } }),
    ]);

  test("attributes commit and backstop domain balances to the market", () => {
    // #given maker backing, a creator bond and insurance moved into the market's domains
    // #when reduced
    const m = ledger().state.markets.get(MARKET);
    // #then backing, bond and insurance come from the ledger moves
    expect([m?.commitTotal, m?.creatorBond, m?.insurance]).toEqual([6_000n, 150n, 50n]);
  });

  test("keeps free balances per account", () => {
    // #given / #when
    const { state } = ledger();
    // #then
    expect([state.vaultBalances.get(ledgerKey(FREE_DOMAIN, MAKER))?.balance, state.vaultBalances.get(ledgerKey(FREE_DOMAIN, CREATOR))?.balance]).toEqual([0n, 300n]);
  });

  test("tracks the ledger total as deposits minus withdrawals", () => {
    // #given / #when
    const v = ledger().state.vaults.get(VAULT);
    // #then
    expect([v?.totalLedger, v?.totalDeposits, v?.totalWithdrawals]).toEqual([6_500n, 10_500n, 4_000n]);
  });

  test("emits deposit and withdrawal movements in order and no violations", () => {
    // #given / #when
    const { out } = ledger();
    // #then
    expect([out.history.vaultMovements.map((m) => `${m.kind}:${m.amount}`), out.violations]).toEqual([["deposit:10000", "deposit:500", "withdraw:4000"], []]);
  });

  test("flags an overdraft and a commitTotal the ledger does not explain", () => {
    // #given an empty ledger
    // #when a withdrawal and a BackingChanged without a matching move arrive
    const { out } = run((clock) => [
      ...marketCreated(clock),
      vault(clock.next(VAULT, { newBlock: true }), { eventName: "Withdrawn", args: { account: TAKER, to: TAKER, amount: 1n } }),
      house(clock.next(CH), { eventName: "BackingChanged", args: { marketId: MARKET, maker: MAKER, delta: 5n, commitTotal: 5n } }),
    ]);
    // #then all three inconsistencies are reported
    expect(out.violations.map((v) => v.message)).toEqual([
      "withdrawals exceed deposits",
      "vault balance would be negative (-1)",
      "commitTotal derived 0 but event reports 5",
    ]);
  });
});

describe("perp position reducer", () => {
  const opened = () =>
    run((clock) => [
      ...marketCreated(clock),
      trade(clock, 2n * WAD, 0n),
      position(clock, 2n * WAD, 400_000_000n, 360_000_000n),
      trade(clock, -WAD, -5n),
      position(clock, WAD, 399_999_995n, 180_000_005n),
    ]);

  test("keeps the reduced pair with its realised PnL and opening block", () => {
    // #given a 2 unit long reduced by 1 unit at a 5 unit loss
    // #when reduced
    const p = opened().state.positions.get(positionKey(MARKET, TAKER));
    // #then
    expect([p?.size, p?.realizedPnl, p?.openedBlock, p?.maker]).toEqual([WAD, -5n, 101n, MAKER]);
  });

  test("moves long open interest with the pair size", () => {
    // #given / #when
    const m = opened().state.markets.get(MARKET);
    // #then
    expect([m?.longOi, m?.shortOi]).toEqual([WAD, 0n]);
  });

  test("records perp fills with collateral notional", () => {
    // #given / #when
    const { out } = opened();
    // #then 2 * 359 USD and 1 * 359 USD in 6-decimal collateral
    expect(out.history.trades.map((t) => t.notionalQuote)).toEqual([718_000_000n, 359_000_000n]);
  });

  test("a full close mirrors the onchain delete of the pair", () => {
    // #given the reduced pair
    const clock = new Clock();
    const state = emptyState();
    applyEvents(state, [...marketCreated(clock), trade(clock, WAD, 0n), position(clock, WAD, 10n, 10n)], ctx);
    // #when it is closed with a realised loss
    const out = applyEvents(state, [trade(clock, -WAD, -3n), position(clock, 0n, 0n, 0n)], ctx);
    // #then size, maker and realised PnL reset as ClearingHouse.getPair reports after `delete`
    const p = state.positions.get(positionKey(MARKET, TAKER));
    expect([p?.size, p?.maker, p?.realizedPnl, p?.openedBlock, state.markets.get(MARKET)?.longOi, out.violations]).toEqual([0n, ZERO, 0n, null, 0n, []]);
  });

  test("short sizes move short open interest", () => {
    // #given a market with 5 long
    const base = run((clock) => marketCreated(clock)).state.markets.get(MARKET);
    if (!base) throw new Error("fixture market missing");
    // #when a short opens at 3 and is reduced to 1
    const afterOpen = nextOpenInterest({ ...base, longOi: 5n }, 0n, -3n);
    const afterReduce = nextOpenInterest({ ...base, ...afterOpen }, -3n, -1n);
    // #then
    expect([afterOpen, afterReduce]).toEqual([
      { longOi: 5n, shortOi: 3n },
      { longOi: 5n, shortOi: 1n },
    ]);
  });
});

describe("bad debt reducer", () => {
  test("keeps the reported total and flags a total the recorded amounts do not explain", () => {
    // #given two bad debt records where the second total skips the first amount
    const { state, out } = run((clock) => [
      ...marketCreated(clock),
      house(clock.next(CH, { newBlock: true }), { eventName: "BadDebtRecorded", args: { marketId: MARKET, amount: 5n, total: 5n } }),
      house(clock.next(CH, { newBlock: true }), { eventName: "BadDebtRecorded", args: { marketId: MARKET, amount: 3n, total: 3n } }),
    ]);
    // #then the onchain total is kept and the gap is reported
    expect([state.markets.get(MARKET)?.badDebt, out.violations.map((v) => v.message)]).toEqual([3n, ["bad debt total 3 is not derived 5 + recorded 3"]]);
  });
});

describe("funding reducer", () => {
  const funded = () =>
    run((clock) => [
      ...marketCreated(clock),
      trade(clock, WAD, 0n),
      position(clock, WAD, 10n, 10n),
      house(clock.next(CH, { newBlock: true }), { eventName: "FundingAccrued", args: { marketId: MARKET, index: 700n, ratePerSecond: 7n, price: WAD, timestamp: 1_800_000_500n } }),
      house(clock.next(CH), { eventName: "FundingSettled", args: { marketId: MARKET, taker: TAKER, maker: MAKER, takerOwed: 5n, takerPaid: 3n } }),
      house(clock.next(CH, { newBlock: true }), { eventName: "FundingAccrued", args: { marketId: MARKET, index: 1_000n, ratePerSecond: 7n, price: WAD, timestamp: 1_800_000_900n } }),
    ]);

  test("records index deltas between accruals and keeps the latest index", () => {
    // #given two accruals
    // #when reduced
    const { state, out } = funded();
    // #then
    const deltas = out.history.fundingEvents.filter((f) => f.kind === "accrued").map((f) => f.indexDelta);
    expect([deltas, state.markets.get(MARKET)?.fundingIndex]).toEqual([[700n, 300n], 1_000n]);
  });

  test("accumulates only the funding that actually moved, not what was owed", () => {
    // #given a settlement that owed 5 and paid 3 / #when reduced
    const p = funded().state.positions.get(positionKey(MARKET, TAKER));
    // #then
    expect(p?.fundingPaid).toBe(3n);
  });

  test("keeps owed and paid separately in funding history", () => {
    // #given / #when
    const settled = funded().out.history.fundingEvents.find((f) => f.kind === "settled");
    // #then
    expect([settled?.takerOwed, settled?.takerPaid]).toEqual([5n, 3n]);
  });
});

describe("spot pool reducer", () => {
  const BOUGHT = 2_643_241_365_150_694_370n;
  const traded = () =>
    run((clock) => [
      ...marketCreated(clock),
      pool(clock.next(POOL, { newBlock: true }), { eventName: "Transfer", args: { from: ZERO, to: DEAD, value: 1_000n } }),
      pool(clock.next(POOL), { eventName: "Transfer", args: { from: ZERO, to: CREATOR, value: 9_000n } }),
      pool(clock.next(POOL), { eventName: "ReservesUpdated", args: { reserve0: 20_000_000_000n, reserve1: 55n * WAD } }),
      pool(clock.next(POOL, { newBlock: true }), {
        eventName: "SwapExecuted",
        args: { sender: TAKER, recipient: TAKER, tokenIn: COLLATERAL, tokenOut: BASE, amountIn: 1_000_000_000n, amountOut: BOUGHT, fee: 2_500_000n },
      }),
      pool(clock.next(POOL, { newBlock: true }), {
        eventName: "SwapExecuted",
        args: { sender: TAKER, recipient: TAKER, tokenIn: BASE, tokenOut: COLLATERAL, amountIn: WAD, amountOut: 375_000_000n, fee: 2_500_000_000_000_000n },
      }),
      pool(clock.next(POOL, { newBlock: true }), { eventName: "Transfer", args: { from: CREATOR, to: ZERO, value: 4_000n } }),
    ]);

  test("tracks reserves, fees by input side and swap count", () => {
    // #given a seeded pool with one buy and one sell
    // #when reduced
    const p = traded().state.pools.get(POOL);
    // #then
    expect([p?.reserve0, p?.feesAccrued0, p?.feesAccrued1, p?.swapCount]).toEqual([20_000_000_000n, 2_500_000n, 2_500_000_000_000_000n, 2]);
  });

  test("derives LP supply and holder balances from mint and burn transfers", () => {
    // #given / #when
    const { state } = traded();
    // #then 1000 locked + 9000 minted - 4000 burned
    expect([state.pools.get(POOL)?.lpSupply, state.lpBalances.get(`${POOL}:${CREATOR}`)?.shares]).toEqual([6_000n, 5_000n]);
  });

  test("prices a quote-for-base swap as quote paid per base received, fee included", () => {
    // #given / #when
    const buy = traded().out.history.trades[0];
    // #then
    expect([buy?.size, buy?.price, buy?.notionalQuote, buy?.account]).toEqual([BOUGHT, (1_000_000_000n * 10n ** 12n * WAD) / BOUGHT, 1_000_000_000n, TAKER]);
  });

  test("prices a base-for-quote swap with a negative size", () => {
    // #given / #when
    const sell = traded().out.history.trades[1];
    // #then
    expect([sell?.size, sell?.price]).toEqual([-WAD, 375n * WAD]);
  });

  test("swapExecution refuses swaps outside the market pair or with unknown decimals", () => {
    // #given the fixture market
    const market = { base: BASE, quote: COLLATERAL };
    // #when / #then
    expect([
      swapExecution(market, BASE, POOL, 1n, 1n, ctx.tokenDecimals),
      swapExecution({ base: POOL, quote: COLLATERAL }, COLLATERAL, POOL, 1n, 1n, ctx.tokenDecimals),
      swapExecution(market, COLLATERAL, BASE, 5n, 0n, ctx.tokenDecimals),
    ]).toEqual([null, null, { size: 0n, price: null, notionalQuote: 5n }]);
  });
});

describe("oracle reducer", () => {
  test("normalises 8-decimal answers to 18 decimals and attributes the configured market", () => {
    // #given two answers from the configured feed
    // #when reduced
    const { out } = run((clock) => [
      feed(clock.next(FEED), { eventName: "AnswerUpdated", args: { current: 35_945_000_000n, roundId: 1n, updatedAt: 1_800_000_000n } }),
      feed(clock.next(FEED), { eventName: "AnswerUpdated", args: { current: 0n, roundId: 2n, updatedAt: 1_800_000_001n } }),
    ]);
    // #then a non-positive answer has no price rather than a zero price
    expect(out.history.oracleObservations.map((o) => [o.priceWad, o.marketId])).toEqual([
      [359_450_000_000_000_000_000n, MARKET],
      [null, MARKET],
    ]);
  });

  test("skips and flags an observation from a feed with unknown decimals", () => {
    // #given an address that is not a known feed
    // #when it emits AnswerUpdated
    const { out } = run((clock) => [feed(clock.next(POOL), { eventName: "AnswerUpdated", args: { current: 1n, roundId: 1n, updatedAt: 1n } })]);
    // #then
    expect([out.history.oracleObservations.length, out.violations[0]?.message]).toEqual([0, "feed decimals unknown; observation skipped"]);
  });

  test("links a registered aggregator to the market that proposes its feed", () => {
    // #given a registered feed
    // #when a market proposes perps with it
    const { state } = run((clock) => [
      oracle(clock.next(ORACLE), { eventName: "FeedRegistered", args: { feedId: FEED_ID, aggregator: FEED, asset: BASE, heartbeat: 3600, decimals: 8 } }),
      ...marketCreated(clock),
      registry(clock.next(REGISTRY), { eventName: "PerpProposed", args: { marketId: MARKET, tierId: 4, feedId: FEED_ID, maxOiUsdWad: WAD, version: 1 } }),
    ]);
    // #then
    expect([state.feedMarkets.get(FEED), state.feeds.get(FEED_ID)?.heartbeat]).toEqual([MARKET, 3600n]);
  });
});

describe("determinism", () => {
  const build = (clock: Clock): IndexedEvent[] => [
    ...marketCreated(clock),
    vault(clock.next(VAULT, { newBlock: true }), { eventName: "Deposited", args: { payer: TAKER, account: TAKER, amount: 77n } }),
    pool(clock.next(POOL), { eventName: "ReservesUpdated", args: { reserve0: 1n, reserve1: 2n } }),
  ];

  test("the same canonical events always produce the same state and rows", () => {
    // #given two independent runs over identical events
    const a = run(build);
    const b = run(build);
    // #then they are byte-identical
    expect(json([a.state, a.out.history])).toBe(json([b.state, b.out.history]));
  });

  test("a cloned state is independent of the original", () => {
    // #given a state and its clone
    const clock = new Clock();
    const state = emptyState();
    applyEvents(state, marketCreated(clock), ctx);
    const copy = cloneState(state);
    // #when only the clone receives a deposit
    applyEvents(copy, [vault(clock.next(VAULT, { newBlock: true }), { eventName: "Deposited", args: { payer: TAKER, account: TAKER, amount: 1n } })], ctx);
    // #then the original is untouched
    expect([state.vaults.size, copy.vaults.size]).toEqual([0, 1]);
  });
});

describe("unit helpers", () => {
  test("perp notional floors |size| * price / 1e18 into collateral units", () => {
    // #given the walkthrough's short fill
    // #then it matches the indexed notional
    expect(perpNotional(-11_016_831_269_995_826_957n, 359_090_550_000_000_000_000n, 6)).toBe(3_956_039_999n);
  });

  test("normalisedAnswer scales positive answers and rejects non-positive ones", () => {
    expect([normalisedAnswer(-1n, 8), normalisedAnswer(1n, 8)]).toEqual([null, 10_000_000_000n]);
  });
});
