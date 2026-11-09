"use client";

import { formatAge, formatFixed } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { fundingPayer, fundingPerHour, price } from "@/lib/display";
import type { ListedMarket } from "@/lib/private/market-list";
import styles from "./trade.module.css";

/** Published risk terms only. Open interest, backing and pool reserves are private, so they aren't shown. */
export function MarketFacts({ m, mode }: { m: ListedMarket; mode: "spot" | "perps" }) {
  const market = m.market;
  return (
    <div className={styles.facts}>
      {mode === "perps" && market ? (
        <dl>
          <div><dt>Max leverage</dt><dd className="num">{`${(1e18 / Number(market.imrWad)).toFixed(1)}x`}</dd></div>
          <div><dt>Initial margin</dt><dd className="num">{`${formatFixed(market.imrWad * 100n, 18, 1)}%`}</dd></div>
          <div><dt>Maintenance margin</dt><dd className="num">{`${formatFixed(market.mmrWad * 100n, 18, 1)}%`}</dd></div>
          <div><dt>Taker fee</dt><dd className="num">{`${Number(market.takerFeeBps) / 100}%`}</dd></div>
          <div><dt>Liquidation penalty</dt><dd className="num">{`${Number(market.penaltyBps) / 100}%`}</dd></div>
          <div><dt>Largest position</dt><dd className="num">{`${formatFixed(market.maxPairSize, 18, 0)} ${m.symbol}`}</dd></div>
          <div><dt>Open interest limit</dt><dd className="num">{`$${formatFixed(market.maxOiUsdWad, 18, 0)}`}</dd></div>
          <div>
            <dt>{copy.perps.funding} (1h)</dt>
            <dd className="num">
              {market.fundingPerSecondWad === null ? "-" : fundingPerHour(market.fundingPerSecondWad)}
              {market.fundingPerSecondWad === null ? null : <span className={styles.factSub}>{fundingPayer(market.fundingPerSecondWad)}</span>}
            </dd>
          </div>
          <div>
            <dt>Price source</dt>
            <dd>
              {price(market.mark)}
              <span className={styles.factSub}>{`Single-operator TEST relay${market.markAgeSeconds !== null ? `, updated ${formatAge(market.markAgeSeconds)} ago` : ""}. It isn't an independent oracle.`}</span>
            </dd>
          </div>
        </dl>
      ) : (
        <dl>
          <div><dt>Pool fee</dt><dd className="num">{m.pool ? `${Number(m.pool.feeBps) / 100}%` : "-"}</dd></div>
          <div><dt>Status</dt><dd>{m.pool?.seeded ? "Open" : "Waiting for a first deposit"}</dd></div>
          <div><dt>Reserves</dt><dd>Private</dd></div>
        </dl>
      )}
    </div>
  );
}
