"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { formatAge } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { fundingPerHour, price } from "@/lib/display";
import { AssetEmblem, PerpStatusPill, Segmented, Skeleton, StateBlock, TestTag } from "@/components/primitives";
import { PrivateUnavailable } from "@/components/private/kit";
import { usePrivate } from "@/lib/private/client";
import { listedMarkets, type ListedMarket } from "@/lib/private/market-list";
import { toggleWatchlist, useWatchlist } from "@/lib/preferences";
import { Search, Star } from "@/components/icons";
import styles from "./markets.module.css";

type Filter = "all" | "saved" | "spot" | "perps";

function WatchButton({ m, watched }: { m: ListedMarket; watched: boolean }) {
  return (
    <button
      type="button"
      className={styles.watch}
      aria-pressed={watched}
      aria-label={watched ? `Remove ${m.symbol} from watchlist` : `Add ${m.symbol} to watchlist`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleWatchlist(m.key);
      }}
    >
      <Star size={16} filled={watched} />
    </button>
  );
}

const modeOf = (m: ListedMarket) => (m.market ? "perps" : "spot");
const leverageOf = (m: ListedMarket) => (m.market ? `${(1e18 / Number(m.market.imrWad)).toFixed(1)}x` : "-");

export function MarketsDirectory() {
  const { view } = usePrivate();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [leverageOnly, setLeverageOnly] = useState(false);
  const router = useRouter();
  const watchlist = useWatchlist();
  const markets = useMemo(() => (view ? listedMarkets(view) : null), [view]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (markets ?? []).filter((m) => {
      if (needle && !(m.symbol.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle))) return false;
      if (filter === "saved" && !watchlist.includes(m.key)) return false;
      if (filter === "perps" && !m.market) return false;
      if (filter === "spot" && m.market) return false;
      if (leverageOnly && !m.market?.markFresh) return false;
      return true;
    });
  }, [markets, q, filter, leverageOnly, watchlist]);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <h1 className="app-title">{copy.nav.markets}</h1>
          <p className="muted" style={{ margin: "8px 0 0" }}>Trade privately, spot or with leverage.</p>
        </div>
        <Link href="/app/create" className="btn">{copy.nav.create}</Link>
      </header>

      <div className={styles.controls}>
        <label className={`input-wrap ${styles.search}`}>
          <Search size={18} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Symbol or name" aria-label="Search markets" style={{ fontFamily: "var(--rq-font-ui-stack)", fontSize: 15 }} />
        </label>
        <Segmented label="Market type" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "saved", label: `Saved (${watchlist.length})` }, { value: "spot", label: "Spot only" }, { value: "perps", label: "With perps" }]} />
        <label className={styles.toggle}>
          <input type="checkbox" checked={leverageOnly} onChange={(e) => setLeverageOnly(e.target.checked)} />
          Leverage available now
        </label>
      </div>

      {!markets ? <PrivateUnavailable /> : null}

      <div className={styles.tablePanel}>
        <div className="table-scroll">
          <table className={`table ${styles.table}`}>
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Saved</span></th>
                <th scope="col">Market</th>
                <th scope="col" className="n">Price</th>
                <th scope="col" className="n">{copy.perps.funding} (1h)</th>
                <th scope="col" className="n">Max leverage</th>
                <th scope="col" className="n">Taker fee</th>
                <th scope="col" className="n">Price updated</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {!markets ? (
                <tr><td colSpan={9}><Skeleton width="60%" /></td></tr>
              ) : rows.map((m) => (
                <tr key={m.key} className="link-row" onClick={() => router.push(`/app/trade/${m.key}?mode=${modeOf(m)}`)}>
                  <td style={{ width: 36, paddingRight: 0 }}><WatchButton m={m} watched={watchlist.includes(m.key)} /></td>
                  <td>
                    <div className={styles.marketCell}>
                      <AssetEmblem logoUrl={m.logoUrl} assetClass={m.assetClass} size={32} label={m.symbol} />
                      <div className={styles.marketText}>
                        <span className="row" style={{ "--gap": "6px" } as React.CSSProperties}>
                          <strong>{m.symbol}</strong>
                          {m.isTestFixture ? <TestTag>Test fixture</TestTag> : m.assetClass === "stock-token" ? <span className="tag" data-tone="verified">Stock Token</span> : null}
                        </span>
                        <span className="t-small muted">{m.name}</span>
                      </div>
                      <div className={styles.modes}>
                        {m.pool ? <span className="tag">{copy.spot.tab}</span> : null}
                        {m.market ? <span className="tag">{`${copy.perps.tab} ${leverageOf(m)}`}</span> : null}
                      </div>
                    </div>
                  </td>
                  <td className="n">{price(m.market?.mark ?? null)}<span className={styles.sub}>{m.market ? "Mark" : ""}</span></td>
                  <td className="n">{m.market?.fundingPerSecondWad === null || !m.market ? "-" : fundingPerHour(m.market.fundingPerSecondWad)}</td>
                  <td className="n">{leverageOf(m)}</td>
                  <td className="n">{m.market ? `${Number(m.market.takerFeeBps) / 100}%` : m.pool ? `${Number(m.pool.feeBps) / 100}%` : "-"}</td>
                  <td className="n">{m.market?.markAgeSeconds === null || !m.market ? "-" : formatAge(m.market.markAgeSeconds)}</td>
                  <td>{m.market ? <PerpStatusPill status="ACTIVE" fresh={m.market.markFresh} /> : <span className="tag">Spot only</span>}</td>
                  <td onClick={(e) => e.stopPropagation()}><Link className="btn btn-sm" href={`/app/trade/${m.key}?mode=${modeOf(m)}`}>{copy.nav.trade}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className={styles.list} role="list">
          {rows.map((m) => (
            <li key={m.key}>
              <Link href={`/app/trade/${m.key}?mode=${modeOf(m)}`} className={styles.listRow}>
                <AssetEmblem logoUrl={m.logoUrl} assetClass={m.assetClass} size={32} label={m.symbol} />
                <span className={styles.marketText}>
                  <strong>{m.symbol}</strong>
                  <span className="t-small muted">{m.name}</span>
                </span>
                <span className={styles.listRight}>
                  <span className="num">{price(m.market?.mark ?? null)}</span>
                  <span className="t-small muted">{m.market ? `${leverageOf(m)} max` : "Spot only"}</span>
                </span>
                <WatchButton m={m} watched={watchlist.includes(m.key)} />
              </Link>
            </li>
          ))}
        </ul>

        {markets && rows.length === 0 ? (
          <div className="empty">
            {filter === "saved" ? "No saved markets yet. Use the star on any market." : "No markets match your filters."}
            <div className="row">
              <button type="button" className="btn" onClick={() => { setQ(""); setFilter("all"); setLeverageOnly(false); }}>Clear filters</button>
            </div>
          </div>
        ) : null}
      </div>
      {markets ? <p className="t-small faint">Prices come from a single-operator testnet relay. Open interest, backing and pool reserves are private.</p> : null}
      {markets && markets.length === 0 ? <StateBlock kind="empty" title="No markets in this deployment" /> : null}
    </div>
  );
}
