"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { formatBps, formatFixed } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { useAccountSnapshot, useMarketSnapshots } from "@/lib/chain-data";
import { shareBps, usePoolExtras } from "@/lib/pools";
import { AssetEmblem, Skeleton, SpotStatusPill, StateBlock, TestTag } from "@/components/primitives";
import styles from "./liquidity.module.css";

/** LQ01. Rooq-owned pools with their actual reserves. No APY: fees are shown as collected amounts. */
export function PoolsList() {
  const { data: markets, isLoading, isError } = useMarketSnapshots();
  const { data: extras } = usePoolExtras();
  const { address } = useAccount();
  const { data: acct } = useAccountSnapshot(address);

  const rows = (markets ?? []).map((m) => {
    const x = extras?.[m.marketId];
    const yours = acct?.lpShares[m.marketId] ?? null;
    const share = x && yours !== null ? shareBps(yours, x.lpSupply) : null;
    return { m, x, yours, share };
  });

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className="t-section">{copy.liquidity.title}</h1>
        <p className="muted" style={{ margin: 0, maxWidth: 680 }}>
          Rooq&apos;s own constant-product pools. Liquidity providers earn the pool&apos;s swap fee in proportion to their share. {copy.liquidity.warning}
        </p>
      </header>
      {isError ? (
        <StateBlock kind="unavailable" title="Pools can't be read right now" body="Nothing below is shown until it can be verified. Try again shortly." />
      ) : null}
      <section className={styles.table} aria-label="Pools">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Pool</th>
                <th scope="col" className="n">
                  {copy.liquidity.reserves}
                </th>
                <th scope="col" className="n">
                  Fee tier
                </th>
                <th scope="col" className="n">
                  Fees collected
                </th>
                <th scope="col" className="n">
                  {copy.liquidity.share}
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array.from({ length: 4 }, (_, i) => (
                    <tr key={i}>
                      <td colSpan={7}>
                        <Skeleton width="50%" />
                      </td>
                    </tr>
                  ))
                : rows.map(({ m, x, yours, share }) => {
                    const baseIs0 = x ? x.token0.toLowerCase() === m.base.address.toLowerCase() : true;
                    const feeBase = x ? (baseIs0 ? x.feesAccrued0 : x.feesAccrued1) : null;
                    const feeQuote = x ? (baseIs0 ? x.feesAccrued1 : x.feesAccrued0) : null;
                    return (
                      <tr key={m.marketId}>
                        <td>
                          <span className={styles.pair}>
                            <AssetEmblem logoUrl={m.base.logoUrl} assetClass={m.base.assetClass} size={24} label={m.base.symbol} />
                            <strong>{`${m.base.symbol} / ${m.quote.symbol}`}</strong>
                            {m.base.isTestFixture ? <TestTag>Test fixture</TestTag> : null}
                          </span>
                        </td>
                        <td className="n">
                          {`${formatFixed(m.reserveBase, m.base.decimals, 4)} ${m.base.symbol}`}
                          <span style={{ display: "block", fontSize: 11, color: "var(--rq-ink-tertiary)" }}>{`${formatFixed(m.reserveQuote, m.quote.decimals, 2)} ${m.quote.symbol}`}</span>
                        </td>
                        <td className="n">{formatBps(m.poolFeeBps)}</td>
                        <td className="n">
                          {feeBase === null ? "—" : `${formatFixed(feeBase, m.base.decimals, 4)} ${m.base.symbol}`}
                          <span style={{ display: "block", fontSize: 11, color: "var(--rq-ink-tertiary)" }}>{feeQuote === null ? "" : `${formatFixed(feeQuote, m.quote.decimals, 2)} ${m.quote.symbol}`}</span>
                        </td>
                        <td className="n">{!address ? "—" : share === null ? "—" : yours === 0n ? "None" : formatBps(share)}</td>
                        <td>{x?.paused ? <SpotStatusPill status="PAUSED" funded /> : <SpotStatusPill status={m.spotStatus} funded={m.reserveBase > 0n} />}</td>
                        <td>
                          <Link className="btn btn-sm" href={`/app/liquidity/${m.deployed.key}`}>
                            Manage
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      </section>
      <ul className={styles.cards}>
        {rows.map(({ m, x, yours, share }) => (
          <li key={m.marketId} className={styles.card}>
            <div className={styles.cardTop}>
              <AssetEmblem logoUrl={m.base.logoUrl} assetClass={m.base.assetClass} size={32} label={m.base.symbol} />
              <strong>{`${m.base.symbol} / ${m.quote.symbol}`}</strong>
              <span style={{ marginLeft: "auto" }}>{x?.paused ? <SpotStatusPill status="PAUSED" funded /> : <SpotStatusPill status={m.spotStatus} funded={m.reserveBase > 0n} />}</span>
            </div>
            <dl className="facts">
              <div>
                <dt>{copy.liquidity.reserves}</dt>
                <dd>
                  {`${formatFixed(m.reserveBase, m.base.decimals, 4)} ${m.base.symbol}`}
                  <span className="sub">{`${formatFixed(m.reserveQuote, m.quote.decimals, 2)} ${m.quote.symbol}`}</span>
                </dd>
              </div>
              <div>
                <dt>Fee tier</dt>
                <dd>{formatBps(m.poolFeeBps)}</dd>
              </div>
              <div>
                <dt>{copy.liquidity.share}</dt>
                <dd>{!address || share === null ? "—" : yours === 0n ? "None" : formatBps(share)}</dd>
              </div>
            </dl>
            <Link className="btn btn-block" href={`/app/liquidity/${m.deployed.key}`}>
              Manage
            </Link>
          </li>
        ))}
      </ul>
      {!isLoading && rows.length === 0 ? <StateBlock kind="empty" title="No pools yet" actions={<Link href="/app/create" className="btn btn-sm">{copy.nav.create}</Link>} /> : null}
    </div>
  );
}
