import type { Address, Hex } from "viem";
import { PERP_STATUS, WAD, absBig, type PerpStatus } from "@rooq/sdk";
import { ZERO_ADDRESS, lower, type DecodedEvent, type IndexedEvent, type LogPosition } from "./decode";
import { FEES_DOMAIN, FREE_DOMAIN, backstopDomain, commitDomain, pairDomain } from "./domains";
import {
  emptyOutput,
  ledgerKey,
  lpKey,
  positionKey,
  type DerivedState,
  type MarketState,
  type PoolState,
  type PositionState,
  type ReduceOutput,
  type ReducerContext,
  type TradeRecord,
} from "./state";

type EventOf<C extends DecodedEvent["contract"]> = Extract<DecodedEvent, { contract: C }>["event"];
type Args<C extends DecodedEvent["contract"], N extends EventOf<C>["eventName"]> = Extract<EventOf<C>, { eventName: N }>["args"];

const positive = (x: bigint): bigint => (x > 0n ? x : 0n);
const negative = (x: bigint): bigint => (x < 0n ? -x : 0n);

function violation(out: ReduceOutput, at: LogPosition, entity: string, message: string): void {
  out.violations.push({ at, entity, message });
}

export function perpStatusOf(code: number): PerpStatus | null {
  return PERP_STATUS[code] ?? null;
}

// ------------------------------------------------------------------ entity reducers (pure)

export function newMarket(at: LogPosition, a: Args<"marketRegistry", "MarketCreated">): MarketState {
  return {
    marketId: lower(a.marketId),
    base: lower(a.base),
    quote: lower(a.quote),
    creator: lower(a.creator),
    pool: lower(a.pool),
    spotStatus: "ACTIVE",
    perpStatus: "NONE",
    tierId: null,
    feedId: null,
    maxOiUsdWad: null,
    imrWad: null,
    riskVersion: null,
    fundingIndex: 0n,
    fundingRatePerSecond: null,
    lastFundingAccrual: null,
    badDebt: 0n,
    longOi: 0n,
    shortOi: 0n,
    commitTotal: 0n,
    insurance: 0n,
    creatorBond: 0n,
    takerFees: 0n,
    tradeCount: 0,
    createdBlock: at.blockNumber,
    createdTx: at.txHash,
    createdAt: at.blockTimestamp,
    statusBlock: null,
    updatedBlock: at.blockNumber,
  };
}

/** Applies a PositionChanged snapshot. A zero size mirrors the onchain `delete` of the pair. */
export function nextPosition(
  prev: PositionState | undefined,
  at: LogPosition,
  a: Args<"clearingHouse", "PositionChanged">,
): PositionState {
  const open = a.size !== 0n;
  const wasOpen = prev !== undefined && prev.size !== 0n;
  return {
    marketId: lower(a.marketId),
    taker: lower(a.taker),
    maker: open ? lower(a.maker) : ZERO_ADDRESS,
    size: a.size,
    entryPrice: a.entryPrice,
    takerMargin: a.takerMargin,
    makerMargin: a.makerMargin,
    realizedPnl: open ? (prev?.realizedPnl ?? 0n) : 0n,
    fundingPaid: open ? (prev?.fundingPaid ?? 0n) : 0n,
    openedBlock: open ? (wasOpen ? (prev?.openedBlock ?? at.blockNumber) : at.blockNumber) : null,
    updatedBlock: at.blockNumber,
    updatedLogIndex: at.logIndex,
    updatedTx: at.txHash,
  };
}

/** Moves open interest from the old signed size to the new one. */
export function nextOpenInterest(market: MarketState, oldSize: bigint, newSize: bigint): Pick<MarketState, "longOi" | "shortOi"> {
  return {
    longOi: market.longOi - positive(oldSize) + positive(newSize),
    shortOi: market.shortOi - negative(oldSize) + negative(newSize),
  };
}

export function emptyPool(pool: Address, at: LogPosition): PoolState {
  return {
    pool,
    marketId: null,
    token0: null,
    token1: null,
    feeBps: null,
    reserve0: 0n,
    reserve1: 0n,
    lpSupply: 0n,
    feesAccrued0: 0n,
    feesAccrued1: 0n,
    paused: false,
    swapCount: 0,
    createdBlock: null,
    updatedBlock: at.blockNumber,
  };
}

export interface SwapExecution {
  readonly size: bigint;
  readonly price: bigint | null;
  readonly notionalQuote: bigint;
}

/**
 * Execution of a swap from the market's point of view: base bought (+) or sold (-) in 18 decimals and
 * the realised quote-per-base price in 18 decimals, fee included. Null when the swap is not between the
 * market's base and quote or a token's decimals are unknown.
 */
export function swapExecution(
  market: Pick<MarketState, "base" | "quote">,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  amountOut: bigint,
  decimals: ReadonlyMap<Address, number>,
): SwapExecution | null {
  const baseDecimals = decimals.get(market.base);
  const quoteDecimals = decimals.get(market.quote);
  if (baseDecimals === undefined || quoteDecimals === undefined || baseDecimals > 18 || quoteDecimals > 18) return null;
  let baseAmount: bigint;
  let quoteAmount: bigint;
  let sign: bigint;
  if (tokenIn === market.quote && tokenOut === market.base) {
    [baseAmount, quoteAmount, sign] = [amountOut, amountIn, 1n];
  } else if (tokenIn === market.base && tokenOut === market.quote) {
    [baseAmount, quoteAmount, sign] = [amountIn, amountOut, -1n];
  } else {
    return null;
  }
  const base18 = baseAmount * 10n ** BigInt(18 - baseDecimals);
  const quote18 = quoteAmount * 10n ** BigInt(18 - quoteDecimals);
  return { size: sign * base18, price: base18 === 0n ? null : (quote18 * WAD) / base18, notionalQuote: quoteAmount };
}

/** Collateral-unit notional of a perp fill: |size| * price / 1e18, scaled down to the token's decimals. */
export function perpNotional(size: bigint, price: bigint, collateralDecimals: number): bigint {
  return (absBig(size) * price) / WAD / 10n ** BigInt(18 - collateralDecimals);
}

export function normalisedAnswer(answer: bigint, decimals: number): bigint | null {
  if (answer <= 0n || decimals > 18) return null;
  return answer * 10n ** BigInt(18 - decimals);
}

// ------------------------------------------------------------------ dispatcher

function touchMarket(state: DerivedState, out: ReduceOutput, next: MarketState): void {
  state.markets.set(next.marketId, next);
  out.touched.markets.add(next.marketId);
}

function updateMarket(
  state: DerivedState,
  out: ReduceOutput,
  at: LogPosition,
  marketId: Hex,
  patch: (m: MarketState) => Partial<MarketState>,
): MarketState | null {
  const id = lower(marketId);
  const market = state.markets.get(id);
  if (!market) {
    violation(out, at, `market:${id}`, "event for a market that was never created");
    return null;
  }
  const next = { ...market, ...patch(market), updatedBlock: at.blockNumber };
  touchMarket(state, out, next);
  return next;
}

function adjustLedger(
  state: DerivedState,
  out: ReduceOutput,
  ctx: ReducerContext,
  at: LogPosition,
  domainRaw: Hex,
  accountRaw: Address,
  delta: bigint,
): void {
  const domain = lower(domainRaw);
  const account = lower(accountRaw);
  const key = ledgerKey(domain, account);
  const balance = (state.vaultBalances.get(key)?.balance ?? 0n) + delta;
  if (balance < 0n) violation(out, at, `ledger:${key}`, `vault balance would be negative (${balance})`);
  state.vaultBalances.set(key, { domain, account, balance, updatedBlock: at.blockNumber });
  out.touched.vaultBalances.add(key);

  const label = state.domains.get(domain);
  if (label?.kind === "commit") {
    updateMarket(state, out, at, label.marketId, (m) => ({ commitTotal: m.commitTotal + delta }));
  } else if (label?.kind === "backstop") {
    updateMarket(state, out, at, label.marketId, (m) =>
      account === ctx.backstop
        ? { insurance: m.insurance + delta }
        : account === m.creator
          ? { creatorBond: m.creatorBond + delta }
          : {},
    );
  }
}

function applyRegistry(state: DerivedState, out: ReduceOutput, at: LogPosition, e: EventOf<"marketRegistry">): void {
  switch (e.eventName) {
    case "MarketCreated": {
      const market = newMarket(at, e.args);
      if (state.markets.has(market.marketId)) {
        violation(out, at, `market:${market.marketId}`, "market created twice");
        return;
      }
      touchMarket(state, out, market);
      state.domains.set(commitDomain(market.marketId), { kind: "commit", marketId: market.marketId });
      state.domains.set(backstopDomain(market.marketId), { kind: "backstop", marketId: market.marketId });
      state.poolMarkets.set(market.pool, market.marketId);
      const pool = state.pools.get(market.pool);
      if (pool) {
        state.pools.set(market.pool, { ...pool, marketId: market.marketId, updatedBlock: at.blockNumber });
        out.touched.pools.add(market.pool);
      }
      return;
    }
    case "PerpProposed": {
      const { marketId, tierId, feedId, maxOiUsdWad, version } = e.args;
      const next = updateMarket(state, out, at, marketId, () => ({
        tierId,
        feedId: lower(feedId),
        maxOiUsdWad,
        riskVersion: version,
      }));
      const feed = state.feeds.get(lower(feedId));
      if (next && feed) state.feedMarkets.set(feed.aggregator, next.marketId);
      return;
    }
    case "StatusChanged": {
      const { marketId, from, to, by } = e.args;
      const fromStatus = perpStatusOf(from);
      const toStatus = perpStatusOf(to);
      if (!fromStatus || !toStatus) {
        violation(out, at, `market:${lower(marketId)}`, `unknown perp status code ${from} -> ${to}`);
        return;
      }
      const prev = state.markets.get(lower(marketId));
      if (prev && prev.perpStatus !== fromStatus) {
        violation(out, at, `market:${prev.marketId}`, `status change from ${fromStatus} but derived status is ${prev.perpStatus}`);
      }
      const next = updateMarket(state, out, at, marketId, () => ({ perpStatus: toStatus, statusBlock: at.blockNumber }));
      if (next) out.history.marketStatusEvents.push({ at, marketId: next.marketId, from: fromStatus, to: toStatus, by: lower(by) });
      return;
    }
    case "RiskTightened": {
      const { marketId, maxOiUsdWad, imrWad } = e.args;
      updateMarket(state, out, at, marketId, () => ({ maxOiUsdWad, imrWad }));
      return;
    }
    default:
      return;
  }
}

function applyClearingHouse(
  state: DerivedState,
  out: ReduceOutput,
  ctx: ReducerContext,
  at: LogPosition,
  e: EventOf<"clearingHouse">,
): void {
  switch (e.eventName) {
    case "TradeExecuted": {
      const a = e.args;
      const marketId = lower(a.marketId);
      const taker = lower(a.taker);
      const trade: TradeRecord = {
        at,
        kind: "perp",
        marketId,
        pool: null,
        account: taker,
        counterparty: lower(a.maker),
        size: a.sizeDelta,
        price: a.price,
        markPrice: a.markPrice,
        fee: a.fee,
        feeToken: ctx.collateral,
        notionalQuote: perpNotional(a.sizeDelta, a.price, ctx.collateralDecimals),
        realizedPnl: a.realizedPnl,
        quoteHash: lower(a.quoteHash),
        tokenIn: null,
        tokenOut: null,
        amountIn: null,
        amountOut: null,
      };
      out.history.trades.push(trade);
      updateMarket(state, out, at, marketId, (m) => ({ takerFees: m.takerFees + a.fee, tradeCount: m.tradeCount + 1 }));
      const key = positionKey(marketId, taker);
      const prev = state.positions.get(key);
      state.positions.set(key, {
        marketId,
        taker,
        maker: prev?.maker ?? lower(a.maker),
        size: prev?.size ?? 0n,
        entryPrice: prev?.entryPrice ?? 0n,
        takerMargin: prev?.takerMargin ?? 0n,
        makerMargin: prev?.makerMargin ?? 0n,
        realizedPnl: (prev?.realizedPnl ?? 0n) + a.realizedPnl,
        fundingPaid: prev?.fundingPaid ?? 0n,
        openedBlock: prev?.openedBlock ?? null,
        updatedBlock: at.blockNumber,
        updatedLogIndex: at.logIndex,
        updatedTx: at.txHash,
      });
      out.touched.positions.add(key);
      return;
    }
    case "PositionChanged": {
      const a = e.args;
      const marketId = lower(a.marketId);
      const taker = lower(a.taker);
      const key = positionKey(marketId, taker);
      const prev = state.positions.get(key);
      const next = nextPosition(prev, at, a);
      state.positions.set(key, next);
      out.touched.positions.add(key);
      state.domains.set(pairDomain(marketId, taker), { kind: "pair", marketId, taker });
      const market = updateMarket(state, out, at, marketId, (m) => nextOpenInterest(m, prev?.size ?? 0n, next.size));
      if (market && (market.longOi < 0n || market.shortOi < 0n)) {
        violation(out, at, `market:${marketId}`, "open interest would be negative");
      }
      out.history.positionEvents.push({
        at,
        marketId,
        taker,
        maker: lower(a.maker),
        size: a.size,
        entryPrice: a.entryPrice,
        takerMargin: a.takerMargin,
        makerMargin: a.makerMargin,
      });
      return;
    }
    case "FundingAccrued": {
      const a = e.args;
      const marketId = lower(a.marketId);
      const before = state.markets.get(marketId)?.fundingIndex ?? 0n;
      updateMarket(state, out, at, marketId, () => ({
        fundingIndex: a.index,
        fundingRatePerSecond: a.ratePerSecond,
        lastFundingAccrual: a.timestamp,
      }));
      out.history.fundingEvents.push({
        at,
        kind: "accrued",
        marketId,
        taker: null,
        maker: null,
        fundingIndex: a.index,
        indexDelta: a.index - before,
        ratePerSecond: a.ratePerSecond,
        price: a.price,
        accruedAt: a.timestamp,
        takerOwed: null,
        takerPaid: null,
      });
      return;
    }
    case "FundingSettled": {
      const a = e.args;
      const marketId = lower(a.marketId);
      const taker = lower(a.taker);
      const key = positionKey(marketId, taker);
      const prev = state.positions.get(key);
      if (prev) {
        state.positions.set(key, { ...prev, fundingPaid: prev.fundingPaid + a.takerPaid, updatedBlock: at.blockNumber, updatedLogIndex: at.logIndex, updatedTx: at.txHash });
        out.touched.positions.add(key);
      } else {
        violation(out, at, `position:${key}`, "funding settled for a pair that was never opened");
      }
      out.history.fundingEvents.push({
        at,
        kind: "settled",
        marketId,
        taker,
        maker: lower(a.maker),
        fundingIndex: null,
        indexDelta: null,
        ratePerSecond: null,
        price: null,
        accruedAt: null,
        takerOwed: a.takerOwed,
        takerPaid: a.takerPaid,
      });
      return;
    }
    case "Liquidated": {
      const a = e.args;
      out.history.liquidations.push({
        at,
        kind: "liquidation",
        marketId: lower(a.marketId),
        taker: lower(a.taker),
        liquidator: lower(a.liquidator),
        makerSide: a.makerSide,
        markPrice: a.markPrice,
        takerPnl: a.takerPnl,
        penalty: a.penalty,
        shortfallCovered: a.shortfallCovered,
        badDebt: a.badDebt,
      });
      return;
    }
    case "SettledAtMark": {
      const a = e.args;
      out.history.liquidations.push({
        at,
        kind: "settled_at_mark",
        marketId: lower(a.marketId),
        taker: lower(a.taker),
        liquidator: null,
        makerSide: null,
        markPrice: a.markPrice,
        takerPnl: a.takerPnl,
        penalty: null,
        shortfallCovered: null,
        badDebt: null,
      });
      return;
    }
    case "BackingChanged": {
      const a = e.args;
      const market = state.markets.get(lower(a.marketId));
      // Every BackingChanged follows the vault move it reports, so the derived ledger must agree exactly.
      if (market && market.commitTotal !== a.commitTotal) {
        violation(out, at, `market:${market.marketId}`, `commitTotal derived ${market.commitTotal} but event reports ${a.commitTotal}`);
      }
      return;
    }
    case "BadDebtRecorded": {
      const a = e.args;
      const before = state.markets.get(lower(a.marketId))?.badDebt ?? 0n;
      if (before + a.amount !== a.total) {
        violation(out, at, `market:${lower(a.marketId)}`, `bad debt total ${a.total} is not derived ${before} + recorded ${a.amount}`);
      }
      updateMarket(state, out, at, a.marketId, () => ({ badDebt: a.total }));
      return;
    }
    default:
      return;
  }
}

function applyVault(state: DerivedState, out: ReduceOutput, ctx: ReducerContext, at: LogPosition, e: EventOf<"marginVault">): void {
  const vault = at.address;
  const prev = state.vaults.get(vault) ?? {
    vault,
    totalLedger: 0n,
    totalDeposits: 0n,
    totalWithdrawals: 0n,
    depositCount: 0,
    withdrawCount: 0,
    updatedBlock: at.blockNumber,
  };
  switch (e.eventName) {
    case "Deposited": {
      const { payer, account, amount } = e.args;
      state.vaults.set(vault, {
        ...prev,
        totalLedger: prev.totalLedger + amount,
        totalDeposits: prev.totalDeposits + amount,
        depositCount: prev.depositCount + 1,
        updatedBlock: at.blockNumber,
      });
      out.touched.vaults.add(vault);
      adjustLedger(state, out, ctx, at, FREE_DOMAIN, account, amount);
      out.history.vaultMovements.push({ at, vault, kind: "deposit", account: lower(account), counterparty: lower(payer), amount });
      return;
    }
    case "Withdrawn": {
      const { account, to, amount } = e.args;
      const totalLedger = prev.totalLedger - amount;
      if (totalLedger < 0n) violation(out, at, `vault:${vault}`, "withdrawals exceed deposits");
      state.vaults.set(vault, {
        ...prev,
        totalLedger,
        totalWithdrawals: prev.totalWithdrawals + amount,
        withdrawCount: prev.withdrawCount + 1,
        updatedBlock: at.blockNumber,
      });
      out.touched.vaults.add(vault);
      adjustLedger(state, out, ctx, at, FREE_DOMAIN, account, -amount);
      out.history.vaultMovements.push({ at, vault, kind: "withdraw", account: lower(account), counterparty: lower(to), amount });
      return;
    }
    case "Moved": {
      const { fromDomain, from, toDomain, to, amount } = e.args;
      adjustLedger(state, out, ctx, at, fromDomain, from, -amount);
      adjustLedger(state, out, ctx, at, toDomain, to, amount);
      return;
    }
    default:
      return;
  }
}

function applyOracleAdapter(state: DerivedState, out: ReduceOutput, at: LogPosition, e: EventOf<"oracleAdapter">): void {
  switch (e.eventName) {
    case "FeedRegistered": {
      const { feedId, aggregator, asset, heartbeat, decimals } = e.args;
      const id = lower(feedId);
      const prev = state.feeds.get(id);
      state.feeds.set(id, {
        feedId: id,
        aggregator: lower(aggregator),
        asset: lower(asset),
        heartbeat: BigInt(heartbeat),
        decimals,
        approved: true,
        registeredBlock: prev?.registeredBlock ?? at.blockNumber,
        updatedBlock: at.blockNumber,
      });
      out.touched.feeds.add(id);
      for (const market of state.markets.values()) {
        if (market.feedId === id) state.feedMarkets.set(lower(aggregator), market.marketId);
      }
      return;
    }
    case "FeedRevoked": {
      const id = lower(e.args.feedId);
      const prev = state.feeds.get(id);
      if (!prev) {
        violation(out, at, `feed:${id}`, "revoked a feed that was never registered");
        return;
      }
      state.feeds.set(id, { ...prev, approved: false, updatedBlock: at.blockNumber });
      out.touched.feeds.add(id);
      return;
    }
    default:
      return;
  }
}

function applyFactory(state: DerivedState, out: ReduceOutput, at: LogPosition, e: EventOf<"spotFactory">): void {
  if (e.eventName !== "PoolCreated") return;
  const { pool, token0, token1, feeTier } = e.args;
  const address = lower(pool);
  const prev = state.pools.get(address) ?? emptyPool(address, at);
  state.pools.set(address, {
    ...prev,
    marketId: state.poolMarkets.get(address) ?? prev.marketId,
    token0: lower(token0),
    token1: lower(token1),
    feeBps: feeTier,
    createdBlock: at.blockNumber,
    updatedBlock: at.blockNumber,
  });
  out.touched.pools.add(address);
}

function adjustLp(state: DerivedState, out: ReduceOutput, at: LogPosition, pool: Address, holder: Address, delta: bigint): void {
  const key = lpKey(pool, holder);
  const shares = (state.lpBalances.get(key)?.shares ?? 0n) + delta;
  if (shares < 0n) violation(out, at, `lp:${key}`, `LP balance would be negative (${shares})`);
  state.lpBalances.set(key, { pool, holder, shares, updatedBlock: at.blockNumber });
  out.touched.lpBalances.add(key);
}

function applyPool(state: DerivedState, out: ReduceOutput, ctx: ReducerContext, at: LogPosition, e: EventOf<"spotPool">): void {
  const address = at.address;
  const pool = state.pools.get(address) ?? emptyPool(address, at);
  const marketId = pool.marketId ?? state.poolMarkets.get(address) ?? null;
  const save = (next: PoolState) => {
    state.pools.set(address, { ...next, marketId, updatedBlock: at.blockNumber });
    out.touched.pools.add(address);
  };
  const base = { at, pool: address, marketId, actor: null, counterparty: null, amount0: null, amount1: null, shares: null, reserve0: null, reserve1: null };
  switch (e.eventName) {
    case "ReservesUpdated": {
      const { reserve0, reserve1 } = e.args;
      save({ ...pool, reserve0, reserve1 });
      out.history.poolEvents.push({ ...base, eventKind: "reserves", reserve0, reserve1 });
      return;
    }
    case "SwapExecuted": {
      const a = e.args;
      const tokenIn = lower(a.tokenIn);
      const tokenOut = lower(a.tokenOut);
      const zeroForOne = pool.token0 !== null ? tokenIn === pool.token0 : null;
      if (zeroForOne === null) violation(out, at, `pool:${address}`, "swap on a pool whose tokens are unknown");
      save({
        ...pool,
        feesAccrued0: zeroForOne === true ? pool.feesAccrued0 + a.fee : pool.feesAccrued0,
        feesAccrued1: zeroForOne === false ? pool.feesAccrued1 + a.fee : pool.feesAccrued1,
        swapCount: pool.swapCount + 1,
      });
      out.history.poolEvents.push({
        ...base,
        eventKind: "swap",
        actor: lower(a.sender),
        counterparty: lower(a.recipient),
        amount0: zeroForOne === null ? null : zeroForOne ? a.amountIn : -a.amountOut,
        amount1: zeroForOne === null ? null : zeroForOne ? -a.amountOut : a.amountIn,
      });
      const market = marketId ? state.markets.get(marketId) : undefined;
      const exec = market ? swapExecution(market, tokenIn, tokenOut, a.amountIn, a.amountOut, ctx.tokenDecimals) : null;
      out.history.trades.push({
        at,
        kind: "swap",
        marketId,
        pool: address,
        account: at.txFrom ?? lower(a.recipient),
        counterparty: lower(a.recipient),
        size: exec?.size ?? null,
        price: exec?.price ?? null,
        markPrice: null,
        fee: a.fee,
        feeToken: tokenIn,
        notionalQuote: exec?.notionalQuote ?? null,
        realizedPnl: null,
        quoteHash: null,
        tokenIn,
        tokenOut,
        amountIn: a.amountIn,
        amountOut: a.amountOut,
      });
      return;
    }
    case "LiquidityAdded": {
      const a = e.args;
      out.history.poolEvents.push({ ...base, eventKind: "add", actor: lower(a.sender), counterparty: lower(a.owner), amount0: a.amount0, amount1: a.amount1, shares: a.shares });
      return;
    }
    case "LiquidityRemoved": {
      const a = e.args;
      out.history.poolEvents.push({ ...base, eventKind: "remove", actor: lower(a.sender), counterparty: lower(a.recipient), amount0: -a.amount0, amount1: -a.amount1, shares: a.shares });
      return;
    }
    case "Transfer": {
      const from = lower(e.args.from);
      const to = lower(e.args.to);
      const value = e.args.value;
      let lpSupply = pool.lpSupply;
      if (from === ZERO_ADDRESS) lpSupply += value;
      else adjustLp(state, out, at, address, from, -value);
      if (to === ZERO_ADDRESS) lpSupply -= value;
      else adjustLp(state, out, at, address, to, value);
      if (lpSupply < 0n) violation(out, at, `pool:${address}`, "LP supply would be negative");
      save({ ...pool, lpSupply });
      return;
    }
    case "PoolPaused": {
      save({ ...pool, paused: true });
      out.history.poolEvents.push({ ...base, eventKind: "pause" });
      return;
    }
    case "PoolUnpaused": {
      save({ ...pool, paused: false });
      out.history.poolEvents.push({ ...base, eventKind: "unpause" });
      return;
    }
    case "Skimmed": {
      const a = e.args;
      out.history.poolEvents.push({ ...base, eventKind: "skim", counterparty: lower(a.to), amount0: -a.amount0, amount1: -a.amount1 });
      return;
    }
    default:
      return;
  }
}

function applyFeed(state: DerivedState, out: ReduceOutput, ctx: ReducerContext, at: LogPosition, e: EventOf<"priceFeed">): void {
  if (e.eventName !== "AnswerUpdated") return;
  const feed = at.address;
  const decimals = ctx.feedDecimals.get(feed);
  if (decimals === undefined) {
    violation(out, at, `feed:${feed}`, "feed decimals unknown; observation skipped");
    return;
  }
  const { current, roundId, updatedAt } = e.args;
  out.history.oracleObservations.push({
    at,
    feed,
    marketId: state.feedMarkets.get(feed) ?? ctx.configFeedMarkets.get(feed) ?? null,
    roundId,
    answer: current,
    decimals,
    priceWad: normalisedAnswer(current, decimals),
    updatedAt,
  });
}

/** Folds one canonical event into the state. Deterministic: no I/O, no clock, no randomness. */
export function applyEvent(state: DerivedState, ev: IndexedEvent, ctx: ReducerContext, out: ReduceOutput): void {
  const { at, decoded } = ev;
  switch (decoded.contract) {
    case "marketRegistry":
      return applyRegistry(state, out, at, decoded.event);
    case "clearingHouse":
      return applyClearingHouse(state, out, ctx, at, decoded.event);
    case "marginVault":
      return applyVault(state, out, ctx, at, decoded.event);
    case "oracleAdapter":
      return applyOracleAdapter(state, out, at, decoded.event);
    case "spotFactory":
      return applyFactory(state, out, at, decoded.event);
    case "spotPool":
      return applyPool(state, out, ctx, at, decoded.event);
    case "priceFeed":
      return applyFeed(state, out, ctx, at, decoded.event);
    case "marketBackstop":
    case "marketPreflight":
      // Backstop balances are derived from the vault Moved events they cause; activation from StatusChanged.
      return;
  }
}

export function applyEvents(state: DerivedState, events: readonly IndexedEvent[], ctx: ReducerContext): ReduceOutput {
  const out = emptyOutput();
  for (const ev of events) applyEvent(state, ev, ctx, out);
  return out;
}

/** Ledger domain label for display, using the labels learned while reducing. */
export function domainKind(state: DerivedState, domain: Hex): { kind: string; marketId: Hex | null } {
  if (domain === FREE_DOMAIN) return { kind: "free", marketId: null };
  if (domain === FEES_DOMAIN) return { kind: "fees", marketId: null };
  const label = state.domains.get(domain);
  if (!label) return { kind: "unknown", marketId: null };
  if (label.kind === "free" || label.kind === "fees") return { kind: label.kind, marketId: null };
  return { kind: label.kind, marketId: label.marketId };
}
