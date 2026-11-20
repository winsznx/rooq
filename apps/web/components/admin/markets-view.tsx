"use client";

import { UNKNOWN, formatAge } from "@rooq/sdk";
import type { AdminMarket, AdminMarkets } from "@rooq/private-sdk/admin";
import { AssetEmblem, StateBlock } from "@/components/primitives";
import { useAdminMarkets, useAdminRange } from "@/lib/admin/hooks";
import { marketArtwork } from "@/lib/private/assets";
import { useNow } from "@/lib/use-now";
import styles from "@/app/admin/admin.module.css";
import { count } from "./format";
import { Kpi, KpiStrip } from "./kpi";
import { AdminPageHead } from "./page-head";
import { Loaded, TableSkeleton } from "./query-state";
import { RANGE_LABEL } from "./range-label";

/** The price relay rewrites every feed at least every 15 minutes (RELAY_REFRESH_SECONDS), so two missed rounds is stale. */
const STALE_PRICE_S = 1_800;

function MarketName({ market }: { market: AdminMarket }): React.JSX.Element {
  const art = marketArtwork(BigInt(market.id));
  return (
    <span className="row" style={{ "--gap": "10px" } as React.CSSProperties}>
      <AssetEmblem logoUrl={art.logoUrl} assetClass={art.assetClass} size={24} label={art.label} />
      {market.symbol}
    </span>
  );
}

function Freshness({ age }: { age: number | null }): React.JSX.Element {
  if (age === null)
    return (
      <span className="pill" data-tone="neutral">
        No price yet
      </span>
    );
  const fresh = age <= STALE_PRICE_S;
  return (
    <span className="pill" data-tone={fresh ? "positive" : "warning"}>
      {fresh ? "Fresh" : "Stale"}
    </span>
  );
}

function MarketsTable({ markets }: { markets: readonly AdminMarket[] }): React.JSX.Element {
  const now = useNow();
  return (
    <section className="panel" aria-label="Perp markets">
      <div className="panel-head">
        <h2 className={styles.panelTitle}>Perp markets</h2>
      </div>
      <div className="table-scroll">
        <table className="table">
          <caption className="sr-only">Price freshness and pair lifecycle counts per market</caption>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Price</th>
              <th scope="col" className="n">
                Last update
              </th>
              <th scope="col" className="n">
                Updates
              </th>
              <th scope="col" className="n">
                Pairs opened
              </th>
              <th scope="col" className="n">
                Closed
              </th>
              <th scope="col" className="n">
                Liquidated
              </th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => {
              const age = m.lastPriceAt === null ? null : now - m.lastPriceAt;
              return (
                <tr key={m.id}>
                  <th scope="row">
                    <MarketName market={m} />
                  </th>
                  <td>
                    <Freshness age={age} />
                  </td>
                  <td className={`n ${age !== null && age > STALE_PRICE_S ? "warn" : ""}`}>{age === null ? UNKNOWN : formatAge(age)}</td>
                  <td className="n">{count(m.priceUpdatesInRange)}</td>
                  <td className="n">{count(m.opened)}</td>
                  <td className="n">{count(m.closed)}</td>
                  <td className="n">{count(m.liquidated)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className={styles.tableNote}>Counts of public lifecycle events only. Sizes, sides and amounts stay private.</p>
    </section>
  );
}

function PoolsTable({ data }: { data: AdminMarkets }): React.JSX.Element {
  return (
    <section className="panel" aria-label="Spot pools">
      <div className="panel-head">
        <h2 className={styles.panelTitle}>Spot pools</h2>
      </div>
      {data.pools.length === 0 ? (
        <StateBlock kind="empty" title="No spot pools on this deployment" />
      ) : (
        <div className="table-scroll">
          <table className="table">
            <caption className="sr-only">Pool state updates per spot pool</caption>
            <thead>
              <tr>
                <th scope="col">Pool</th>
                <th scope="col" className="n">
                  State updates
                </th>
              </tr>
            </thead>
            <tbody>
              {data.pools.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.symbol}</th>
                  <td className="n">{count(p.updatesInRange)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.tableNote}>Each update is one swap or liquidity change settled into the pool. Reserves aren&apos;t shown here.</p>
    </section>
  );
}

function MarketsBody({ data }: { data: AdminMarkets }): React.JSX.Element {
  const sum = (pick: (m: AdminMarket) => number): number => data.markets.reduce((acc, m) => acc + pick(m), 0);
  return (
    <>
      <KpiStrip label="Market totals">
        <Kpi label="Perp markets" value={count(data.markets.length)} sub={`${count(data.marketsCreated)} created through the markets module`} />
        <Kpi label="Pairs opened" value={count(sum((m) => m.opened))} sub="In range" />
        <Kpi label="Pairs closed" value={count(sum((m) => m.closed))} sub="In range" />
        <Kpi label="Liquidations" value={count(sum((m) => m.liquidated))} sub="In range" />
        <Kpi label="Pool updates" value={count(data.pools.reduce((acc, p) => acc + p.updatesInRange, 0))} sub={`${count(data.pools.length)} pools`} />
      </KpiStrip>
      {data.markets.length === 0 ? <StateBlock kind="empty" title="No perp markets on this deployment" /> : <MarketsTable markets={data.markets} />}
      <PoolsTable data={data} />
    </>
  );
}

export function MarketsView(): React.JSX.Element {
  const range = useAdminRange();
  const markets = useAdminMarkets(range);
  return (
    <>
      <AdminPageHead title="Markets" lede={`${RANGE_LABEL[range]} for counts. Price ages are measured now against the wall clock.`} />
      <Loaded query={markets} fallback={<TableSkeleton label="Loading markets" rows={6} />}>
        {(data) => <MarketsBody data={data} />}
      </Loaded>
    </>
  );
}
