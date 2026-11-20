import type {
  AdminActions, AdminFees, AdminFlowSeries, AdminFlows, AdminIndexerState, AdminKinds, AdminMarkets, AdminMoney, AdminOperator, AdminOperators, AdminOverview, AdminPeople,
  AdminServices, AdminToken, AdminTraffic, AdminVault, AdminWallets, AssetAmount, SeriesPoint,
} from "@rooq/private-sdk/admin";
import { getAddress, type Address } from "viem";
import { ServiceError } from "./errors";
import { answerKind } from "./analytics-events";
import type { OperatorBook } from "./analytics-operators";
import { cents, changePct, PriceHistory, usdValue, type PricedFeed } from "./analytics-prices";
import { WALLET_ACTIONS } from "./analytics-selectors";
import { bucketStart, BUCKET_SECONDS, cumulative, denseSeries, firstPoint, type Window } from "./analytics-series";
import type { AmountRow, AnalyticsStore, BucketCount } from "./analytics-store";
import type { TokenBook } from "./analytics-tokens";

export interface MarketMeta {
  readonly id: number;
  readonly symbol: string;
  readonly feed: Address;
}

export interface PoolMeta {
  readonly id: number;
  readonly symbol: string;
}

export interface ReportDeps {
  readonly store: AnalyticsStore;
  readonly indexer: { state(): AdminIndexerState };
  readonly operators: OperatorBook;
  readonly services: { snapshot(): Promise<AdminServices> };
  readonly tokens: TokenBook;
  markets(): readonly MarketMeta[];
  pools(): readonly PoolMeta[];
  /** Unix seconds of the market's last oracle update, read live; null when the read fails. */
  lastPriceAt(market: MarketMeta): Promise<number | null>;
  /** The deployment's stablecoin, valued at one dollar. */
  readonly stableAsset: string;
  /** Stock Tokens and the feeds that price them. */
  feeds(): readonly PricedFeed[];
  readonly vault: { snapshot(): Promise<AdminVault> };
  /** Null when the $ROOQ slice is not configured (no ROOQ_TOKEN_RPC_URL); the route then answers 503 NOT_CONFIGURED. */
  readonly token: { report(w: Window): Promise<AdminToken> } | null;
}

const ORACLE_PREFIX = "AnswerUpdated:";
const ORACLE_ACTION = "setAnswer";
/** The ADMIN_OPERATORS label of the wallet that submits unshields and is paid their fee. */
const RELAYER_LABEL = "relayer";
const DAY = 86_400;

type Direction = "in" | "out";

interface Valued {
  readonly time: number;
  readonly asset: string;
  readonly amount: bigint;
  readonly direction: Direction;
  /** Null when the asset had no price at the time or its decimals aren't known yet. */
  readonly usd: number | null;
}

const sumUsd = (rows: readonly Valued[]): number => rows.reduce((sum, r) => sum + (r.usd ?? 0), 0);

/** Points can be fractional dollars, which denseSeries sums like counts. */
const usdPoints = (rows: readonly Valued[]): BucketCount[] => rows.flatMap((r) => (r.usd === null ? [] : [{ t: r.time, n: r.usd }]));

const roundSeries = (series: readonly SeriesPoint[]): SeriesPoint[] => series.map((p) => ({ t: p.t, v: cents(p.v) }));


/**
 * Builds every admin response from the store. Outputs are counts, public chain amounts and operator EOAs only: the
 * wallet table is read as counts, and no per-pair or per-position figure exists in the store to begin with.
 */
export class AdminReports {
  constructor(private readonly deps: ReportDeps) {}

  private assetAmount(asset: string, amount: bigint): AssetAmount {
    const info = this.deps.tokens.info(asset);
    const address = getAddress(asset);
    return { asset: address, symbol: info?.symbol ?? address, decimals: info?.decimals ?? 0, decimalsKnown: info !== null, amount: amount.toString() };
  }

  private sumByAsset<R extends AmountRow>(rows: readonly R[], pick: (row: R) => string): AssetAmount[] {
    const sums = new Map<string, bigint>();
    for (const r of rows) sums.set(r.asset, (sums.get(r.asset) ?? 0n) + BigInt(pick(r)));
    return [...sums].map(([asset, amount]) => this.assetAmount(asset, amount)).sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  /** Our gas by sender over the window: exact for indexed transactions, sampled per hour for oracle writes. */
  private operatorGas(since: number): Map<string, bigint> {
    const senders = this.deps.operators.addresses;
    const gas = this.deps.store.operatorFees(senders, since);
    for (const o of this.deps.store.oracleWrites(since)) if (senders.includes(o.from)) gas.set(o.from, (gas.get(o.from) ?? 0n) + o.feeWei);
    return gas;
  }

  private oracleCount(since: number): number {
    return this.deps.store.eventTotals(since, ORACLE_PREFIX).reduce((sum, r) => sum + r.n, 0);
  }

  async overview(w: Window): Promise<AdminOverview> {
    const { store } = this.deps;
    const operators = this.deps.operators.addresses;
    const shields = store.shieldAmounts(w.since);
    const unshields = store.unshieldAmounts(w.since);
    const categories = store.txCategoryCounts(w.since);
    const countOf = (category: "user" | "maintenance"): number => categories.find((c) => c.category === category)?.n ?? 0;
    const traffic = store.pageviewTotals(w.since, "site");
    const services = await this.deps.services.snapshot();
    const stateCount = (state: "ok" | "degraded" | "down"): number => services.services.filter((s) => s.state === state).length;
    return {
      range: w.range,
      indexer: this.deps.indexer.state(),
      wallets: { total: store.walletCount(0, operators), newInRange: store.walletCount(w.since, operators) },
      shields: { count: shields.length, byAsset: this.sumByAsset(shields, (r) => r.amount) },
      unshields: { count: unshields.length, byAsset: this.sumByAsset(unshields, (r) => r.amount), relayerFees: this.sumByAsset(unshields, (r) => r.fee) },
      txs: { user: countOf("user"), maintenance: countOf("maintenance"), oracle: this.oracleCount(w.since), reverted: categories.reduce((sum, c) => sum + c.reverted, 0) },
      operatorGasWei: [...this.operatorGas(w.since).values()].reduce((a, b) => a + b, 0n).toString(),
      traffic: { views: traffic.reduce((s, r) => s + r.views, 0), visits: traffic.reduce((s, r) => s + r.visits, 0) },
      services: { ok: stateCount("ok"), degraded: stateCount("degraded"), down: stateCount("down") },
    };
  }

  actions(w: Window): AdminActions {
    const { store } = this.deps;
    const size = BUCKET_SECONDS[w.bucket];
    const rows: AdminActions["rows"] = store.actionCounts(w.since).map((r) => ({ action: r.action, category: r.category, count: r.n, reverted: r.reverted }));
    const oracle = this.oracleCount(w.since);
    if (oracle > 0) rows.push({ action: ORACLE_ACTION, category: "oracle", count: oracle, reverted: 0 });
    rows.sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));
    const user = store.txSeries(w.since, size, "user");
    const maintenance = store.txSeries(w.since, size, "maintenance");
    const oracleSeries = store.eventSeries(w.since, size, ORACLE_PREFIX);
    const start = firstPoint(user, maintenance, oracleSeries);
    return {
      range: w.range,
      bucket: w.bucket,
      rows,
      series: { user: denseSeries(user, w, start), maintenance: denseSeries(maintenance, w, start), oracle: denseSeries(oracleSeries, w, start) },
    };
  }

  flows(w: Window): AdminFlows {
    const shields = this.deps.store.shieldAmounts(w.since);
    const unshields = this.deps.store.unshieldAmounts(w.since);
    const start = [...shields, ...unshields].reduce<number | undefined>((min, r) => (min === undefined || r.time < min ? r.time : min), undefined);
    return { range: w.range, bucket: w.bucket, shields: this.flowSeries(shields, w, start), unshields: this.flowSeries(unshields, w, start) };
  }

  /** Per asset, counts and base-unit amounts per bucket. Amounts are summed exactly and converted to a number per point. */
  private flowSeries(rows: readonly AmountRow[], w: Window, start: number | undefined): AdminFlowSeries[] {
    const byAsset = new Map<string, Map<number, { n: number; amount: bigint }>>();
    for (const r of rows) {
      const buckets = byAsset.get(r.asset) ?? new Map<number, { n: number; amount: bigint }>();
      const t = bucketStart(r.time, w.bucket);
      const acc = buckets.get(t) ?? { n: 0, amount: 0n };
      buckets.set(t, { n: acc.n + 1, amount: acc.amount + BigInt(r.amount) });
      byAsset.set(r.asset, buckets);
    }
    return [...byAsset]
      .map(([asset, buckets]) => {
        const points = [...buckets].sort(([a], [b]) => a - b);
        const meta = this.assetAmount(asset, 0n);
        return {
          asset: meta.asset,
          symbol: meta.symbol,
          decimals: meta.decimals,
          decimalsKnown: meta.decimalsKnown,
          count: denseSeries(points.map(([t, v]) => ({ t, n: v.n })), w, start),
          amount: denseSeries(points.map(([t, v]) => ({ t, n: Number(v.amount) })), w, start),
        };
      })
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  wallets(w: Window): AdminWallets {
    const { store } = this.deps;
    const operators = this.deps.operators.addresses;
    const total = store.walletCount(0, operators);
    const newInRange = store.walletCount(w.since, operators);
    const newPerBucket = denseSeries(store.walletsPerBucket(w.since, BUCKET_SECONDS[w.bucket], operators), w);
    return {
      range: w.range,
      bucket: w.bucket,
      total,
      newInRange,
      newPerBucket,
      cumulative: cumulative(newPerBucket, total - newInRange),
      bySource: store.walletsBySource(operators).map((r) => ({ source: r.source, count: r.n })),
    };
  }

  operators(w: Window): AdminOperators {
    const { store, operators: book } = this.deps;
    const senders = book.addresses;
    const totals = new Map(store.operatorTotals(senders).map((t) => [t.from, t]));
    const oracleAll = new Map(store.oracleWrites(0).map((o) => [o.from, o]));
    const oracleRange = new Map(store.oracleWrites(w.since).map((o) => [o.from, o]));
    const gas = this.operatorGas(w.since);
    const actions = store.operatorActions(senders, w.since);
    const operators: AdminOperator[] = book.operators.map((o) => {
      const key = o.address.toLowerCase();
      const state = book.state(o.address);
      const indexedTxs = (totals.get(key)?.n ?? 0) + (oracleAll.get(key)?.n ?? 0);
      const nonce = state?.nonce ?? 0;
      const own = actions.filter((a) => a.from === key).map((a) => ({ action: a.action, count: a.n }));
      const oracleWrites = oracleRange.get(key)?.n ?? 0;
      if (oracleWrites > 0) own.push({ action: ORACLE_ACTION, count: oracleWrites });
      const last = Math.max(totals.get(key)?.last ?? 0, oracleAll.get(key)?.last ?? 0);
      return {
        label: o.label,
        address: o.address,
        balanceWei: (state?.balanceWei ?? 0n).toString(),
        nonce,
        indexedTxs,
        unindexedTxs: Math.max(0, nonce - indexedTxs),
        gasSpentWei: (gas.get(key) ?? 0n).toString(),
        lastTxAt: last > 0 ? last : null,
        actions: own.sort((a, b) => b.count - a.count || a.action.localeCompare(b.action)),
      };
    });
    return { range: w.range, operators };
  }

  services(): Promise<AdminServices> {
    return this.deps.services.snapshot();
  }

  async markets(w: Window): Promise<AdminMarkets> {
    const { store } = this.deps;
    const totals = (prefix: string): Map<string, number> => new Map(store.eventTotals(w.since, prefix).map((r) => [r.kind, r.n]));
    const answers = totals(ORACLE_PREFIX);
    const opened = totals("PairOpened:");
    const closed = totals("PairClosed:");
    const liquidated = totals("PairLiquidated:");
    const pools = totals("PoolUpdated:");
    const markets = await Promise.all(this.deps.markets().map(async (m) => ({
      id: m.id,
      symbol: m.symbol,
      feed: m.feed,
      lastPriceAt: await this.deps.lastPriceAt(m),
      priceUpdatesInRange: answers.get(answerKind(m.feed)) ?? 0,
      opened: opened.get(`PairOpened:${m.id}`) ?? 0,
      closed: closed.get(`PairClosed:${m.id}`) ?? 0,
      liquidated: liquidated.get(`PairLiquidated:${m.id}`) ?? 0,
    })));
    return {
      range: w.range,
      markets,
      pools: this.deps.pools().map((p) => ({ id: p.id, symbol: p.symbol, updatesInRange: pools.get(`PoolUpdated:${p.id}`) ?? 0 })),
      marketsCreated: store.marketsCreatedCount(),
    };
  }

  private prices(): PriceHistory {
    return new PriceHistory(this.deps.store.oraclePrices(), this.deps.feeds(), this.deps.stableAsset);
  }

  private value<R extends AmountRow>(rows: readonly R[], direction: Direction, prices: PriceHistory, pick: (row: R) => string = (r) => r.amount): Valued[] {
    return rows.map((r) => {
      const amount = BigInt(pick(r));
      const decimals = this.deps.tokens.info(r.asset)?.decimals ?? null;
      const price = prices.priceAt(r.asset, r.time);
      return { time: r.time, asset: r.asset, amount, direction, usd: decimals === null || price === null ? null : usdValue(amount, decimals, price) };
    });
  }

  /**
   * Shield (in) and unshield (out) value in dollars. Volume is in plus out. The comparison window is the same length
   * as this one and ends where it starts.
   */
  money(w: Window): AdminMoney {
    const { store } = this.deps;
    const prices = this.prices();
    const all = [...this.value(store.shieldAmounts(0), "in", prices), ...this.value(store.unshieldAmounts(0), "out", prices)];
    const since = (t: number): Valued[] => all.filter((r) => r.time >= t);
    const inRange = since(w.since);
    const previousStart = w.since - (w.now - w.since);
    const previous = all.filter((r) => r.time >= previousStart && r.time < w.since);
    const ins = inRange.filter((r) => r.direction === "in");
    const outs = inRange.filter((r) => r.direction === "out");
    const inPoints = usdPoints(ins);
    const outPoints = usdPoints(outs);
    const start = firstPoint(inPoints, outPoints);
    const byAsset = new Map<string, { asset: string; direction: Direction; amount: bigint; usd: number }>();
    for (const r of inRange) {
      const key = `${r.direction}|${r.asset}`;
      const acc = byAsset.get(key) ?? { asset: r.asset, direction: r.direction, amount: 0n, usd: 0 };
      byAsset.set(key, { ...acc, amount: acc.amount + r.amount, usd: acc.usd + (r.usd ?? 0) });
    }
    return {
      range: w.range,
      bucket: w.bucket,
      totals: {
        allTimeUsd: cents(sumUsd(all)),
        inRangeUsd: cents(sumUsd(inRange)),
        last24hUsd: cents(sumUsd(since(w.now - DAY))),
        last7dUsd: cents(sumUsd(since(w.now - 7 * DAY))),
        inUsd: cents(sumUsd(ins)),
        outUsd: cents(sumUsd(outs)),
        changePct: w.range === "all" ? null : changePct(sumUsd(inRange), sumUsd(previous)),
      },
      series: { in: roundSeries(denseSeries(inPoints, w, start)), out: roundSeries(denseSeries(outPoints, w, start)) },
      byAsset: [...byAsset.values()]
        .map((a) => ({ ...this.assetAmount(a.asset, a.amount), direction: a.direction, usd: cents(a.usd) }))
        .sort((a, b) => a.direction.localeCompare(b.direction) || b.usd - a.usd || a.symbol.localeCompare(b.symbol)),
      unpriced: inRange.filter((r) => r.usd === null).length,
    };
  }

  vault(): Promise<AdminVault> {
    return this.deps.vault.snapshot();
  }

  /** Relayer fees valued like money, against the gas the relayer and every operator spent. */
  fees(w: Window): AdminFees {
    const { store, operators: book } = this.deps;
    const size = BUCKET_SECONDS[w.bucket];
    const fees = this.value(store.unshieldAmounts(w.since), "out", this.prices(), (r) => r.fee).filter((r) => r.amount > 0n);
    const byAsset = new Map<string, { amount: bigint; usd: number; unpriced: boolean }>();
    for (const r of fees) {
      const acc = byAsset.get(r.asset) ?? { amount: 0n, usd: 0, unpriced: false };
      byAsset.set(r.asset, { amount: acc.amount + r.amount, usd: acc.usd + (r.usd ?? 0), unpriced: acc.unpriced || r.usd === null });
    }
    const gas = this.operatorGas(w.since);
    const relayer = book.operators.find((o) => o.label === RELAYER_LABEL)?.address.toLowerCase();
    const gasSeries = store.operatorFeeSeries(book.addresses, w.since, size);
    return {
      range: w.range,
      bucket: w.bucket,
      relayerFees: [...byAsset]
        .map(([asset, a]) => ({ ...this.assetAmount(asset, a.amount), usd: a.unpriced ? null : cents(a.usd) }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
      relayerFeesUsd: cents(sumUsd(fees)),
      relayerFeesSeries: roundSeries(denseSeries(usdPoints(fees), w)),
      relayerGasWei: (relayer === undefined ? 0n : (gas.get(relayer) ?? 0n)).toString(),
      operatorGasWei: [...gas.values()].reduce((a, b) => a + b, 0n).toString(),
      operatorGasSeries: denseSeries([...gasSeries].map(([t, wei]) => ({ t, n: Number(wei) / 1e18 })), w),
    };
  }

  /** Counts of public wallets; the store answers with counts and no address leaves it. */
  people(w: Window): AdminPeople {
    const { store } = this.deps;
    const operators = this.deps.operators.addresses;
    const actions = [...WALLET_ACTIONS];
    const active = store.activeWallets(w.since, actions, operators);
    return {
      range: w.range,
      bucket: w.bucket,
      active: denseSeries(store.activeWalletsPerBucket(w.since, BUCKET_SECONDS[w.bucket], actions, operators), w),
      activeInRange: active.active,
      newInRange: active.fresh,
      returningInRange: active.active - active.fresh,
      stillShielded: store.stillShielded(operators),
    };
  }

  kinds(w: Window): AdminKinds {
    const rows = this.deps.store.actionSeries(w.since, BUCKET_SECONDS[w.bucket], "user");
    const byAction = new Map<string, BucketCount[]>();
    for (const r of rows) byAction.set(r.action, [...(byAction.get(r.action) ?? []), { t: r.t, n: r.n }]);
    const start = firstPoint(...byAction.values());
    return {
      range: w.range,
      bucket: w.bucket,
      kinds: [...byAction]
        .map(([action, points]) => ({ action, category: "user" as const, series: denseSeries(points, w, start), total: points.reduce((s, p) => s + p.n, 0) }))
        .sort((a, b) => b.total - a.total || a.action.localeCompare(b.action))
        .map(({ action, category, series }) => ({ action, category, series })),
    };
  }

  token(w: Window): Promise<AdminToken> {
    if (!this.deps.token) throw new ServiceError(503, "NOT_CONFIGURED", "The $ROOQ token slice is not configured on this server (ROOQ_TOKEN_RPC_URL is unset).", false);
    return this.deps.token.report(w);
  }

  traffic(w: Window): AdminTraffic {
    const { store } = this.deps;
    const buckets = store.pageviewSeries(w.since, BUCKET_SECONDS[w.bucket]);
    const views: BucketCount[] = buckets.map((b) => ({ t: b.t, n: b.views }));
    const visits: BucketCount[] = buckets.map((b) => ({ t: b.t, n: b.visits }));
    const rows = (by: "route" | "referrer" | "device" | "site"): AdminTraffic["routes"] => store.pageviewTotals(w.since, by).map((r) => ({ key: r.key, views: r.views, visits: r.visits }));
    return {
      range: w.range,
      bucket: w.bucket,
      views: denseSeries(views, w),
      visits: denseSeries(visits, w),
      routes: rows("route"),
      referrers: rows("referrer"),
      devices: rows("device"),
      sites: rows("site"),
    };
  }
}
