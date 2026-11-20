"use client";

import type { AdminBucket, AdminToken } from "@rooq/private-sdk/admin";
import { Address, StateBlock } from "@/components/primitives";
import { bucketFor, useAdminRange, useAdminToken } from "@/lib/admin/hooks";
import styles from "@/app/admin/admin.module.css";
import { ChartSkeleton } from "./chart-skeleton";
import { PRICE_FORMAT, USD_FORMAT } from "./chart-formats";
import { count, ethPrice, ethUnits, tokenUnits, usd, usdPrice } from "./format";
import { IndexerMeta } from "./indexer-meta";
import { Kpi, KpiStrip } from "./kpi";
import { Figure, SplitBar } from "./money-panels";
import { AdminPageHead } from "./page-head";
import { Loaded } from "./query-state";
import { RANGE_LABEL } from "./range-label";
import { bpsLabel } from "./slices";
import { TimeChart } from "./time-chart";

const SYMBOL = "ROOQ";

function times(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a * b;
}

function TradesPanel({ token }: { token: AdminToken }): React.JSX.Element {
  const w = token.window;
  return (
    <section className="panel" aria-labelledby="token-trades">
      <div className="panel-head">
        <h2 id="token-trades" className={styles.panelTitle}>
          Buys and sells
        </h2>
        <span className={styles.panelMeta}>{RANGE_LABEL[w.range]}</span>
      </div>
      <div className={`${styles.panelBody} stack`} style={{ "--gap": "14px" } as React.CSSProperties}>
        <dl className={styles.figures}>
          <Figure label="Buys" value={usd(w.buyUsd)} sub={`${count(w.buys)} ${w.buys === 1 ? "trade" : "trades"}`} />
          <Figure label="Sells" value={usd(w.sellUsd)} sub={`${count(w.sells)} ${w.sells === 1 ? "trade" : "trades"}`} />
        </dl>
        <SplitBar
          label="Buy and sell volume"
          left={{ label: "Buys", value: w.buyUsd, detail: usd(w.buyUsd), tone: "accent" }}
          right={{ label: "Sells", value: w.sellUsd, detail: usd(w.sellUsd), tone: "muted" }}
        />
        <SplitBar
          label="Buy and sell count"
          left={{ label: "Buys", value: w.buys, detail: count(w.buys), tone: "accent" }}
          right={{ label: "Sells", value: w.sells, detail: count(w.sells), tone: "muted" }}
        />
      </div>
    </section>
  );
}

function CreatorFeesPanel({ token }: { token: AdminToken }): React.JSX.Element {
  const fees = token.creatorFees;
  return (
    <section className="panel" aria-labelledby="token-fees">
      <div className="panel-head">
        <h2 id="token-fees" className={styles.panelTitle}>
          Creator fees
        </h2>
        <span className={styles.panelMeta}>{`${bpsLabel(fees.rateBps)} of pool volume`}</span>
      </div>
      <div className={`${styles.panelBody} stack`} style={{ "--gap": "14px" } as React.CSSProperties}>
        <dl className={styles.figures}>
          <Figure label="Waiting to claim" value={ethUnits(fees.pendingEth)} sub={`About ${usd(times(fees.pendingEth, token.ethUsd))}`} />
          <Figure label="Waiting for the sweep" value={tokenUnits(fees.pendingRooq, SYMBOL)} sub={`About ${usd(times(fees.pendingRooq, token.priceUsd))}`} />
          <Figure label="Earned since launch" value={usd(fees.estimatedLifetimeUsd)} sub="Estimate from pool volume" />
        </dl>
        <p className={styles.note}>ETH fees sit in the Pons fee escrow until claimed. ROOQ fees wait for the Pons operator to sweep them.</p>
      </div>
    </section>
  );
}

function TokenBody({ token, bucket }: { token: AdminToken; bucket: AdminBucket }): React.JSX.Element {
  const w = token.window;
  return (
    <>
      <KpiStrip label="$ROOQ key figures" columns={6}>
        <Kpi label="Price" value={usdPrice(token.priceUsd)} sub={ethPrice(token.priceEth)} trend={token.series.price} />
        <Kpi label="Market cap" value={usd(token.marketCapUsd)} sub="At the current price" />
        <Kpi label="Pool liquidity" value={ethUnits(token.poolEth, 3)} sub={`About ${usd(times(token.poolEth, token.ethUsd))}`} />
        <Kpi label="Holders" value={count(token.holders)} sub="Wallets holding ROOQ" />
        <Kpi label="Volume" value={usd(w.volumeUsd)} sub="In range" trend={token.series.volume} />
        <Kpi label="Unique traders" value={count(w.uniqueTraders)} sub="In range" />
      </KpiStrip>
      <div className={styles.split}>
        <TradesPanel token={token} />
        <CreatorFeesPanel token={token} />
      </div>
      <div className={styles.split}>
        <TimeChart title="Price in dollars" bucket={bucket} cumulative format={PRICE_FORMAT} series={[{ id: "price", label: "Price", tone: "ink", kind: "line", points: token.series.price }]} />
        <TimeChart title="Volume in dollars" bucket={bucket} format={USD_FORMAT} series={[{ id: "volume", label: "Volume", tone: "accent", kind: "bar", points: token.series.volume }]} />
      </div>
      <TimeChart
        title="Trades"
        bucket={bucket}
        series={[
          { id: "buys", label: "Buys", tone: "accent", kind: "bar", points: token.series.buys },
          { id: "sells", label: "Sells", tone: "muted", kind: "bar", points: token.series.sells },
        ]}
      />
    </>
  );
}

/** $ROOQ on Robinhood Chain mainnet. Read-only public chain data: the token, its pool and the creator's fees. */
export function TokenView(): React.JSX.Element {
  const range = useAdminRange();
  const token = useAdminToken(range);
  const t = token.data;
  const notConfigured = t === undefined && token.error?.notConfigured === true;
  return (
    <>
      <AdminPageHead
        title="$ROOQ"
        meta={t ? <IndexerMeta indexer={t.indexer} /> : null}
        lede={
          <>
            {`${RANGE_LABEL[range]} for volume and trades. Prices and balances are read now. Robinhood Chain mainnet, traded in a Uniswap v4 pool launched on Pons. `}
            {t ? <Address value={t.token} /> : null}
          </>
        }
      />
      {notConfigured ? (
        <div className="panel">
          <StateBlock kind="empty" title="$ROOQ isn't tracked on this deployment" body="Point the analytics service at the token and a Robinhood Chain mainnet RPC, and this view fills in." />
        </div>
      ) : (
        <Loaded
          query={token}
          fallback={
            <>
              <KpiStrip label="Loading $ROOQ key figures" columns={6}>
                {["Price", "Market cap", "Pool liquidity", "Holders", "Volume", "Unique traders"].map((label) => (
                  <Kpi key={label} label={label} value={undefined} />
                ))}
              </KpiStrip>
              <ChartSkeleton />
            </>
          }
        >
          {(data) => <TokenBody token={data} bucket={bucketFor(range)} />}
        </Loaded>
      )}
    </>
  );
}
