"use client";

import Link from "next/link";
import { copy } from "@rooq/ui";
import { formatAge } from "@rooq/sdk";
import { LayoutGroup, motion } from "motion/react";
import { fundingPerHour, price } from "@/lib/display";
import { TRANSITION } from "@/lib/motion";
import { toggleWatchlist, useWatchlist } from "@/lib/preferences";
import type { ListedMarket } from "@/lib/private/market-list";
import { AssetEmblem, PerpStatusPill, SpotStatusPill, TestTag } from "../primitives";
import { ChevronDown, Star } from "../icons";
import { useShell } from "../shell/app-shell";
import styles from "./trade.module.css";

export type Mode = "spot" | "perps";

/** One line above the datum rule: asset, mode, status and the market's one price. */
export function MarketHeader({ m, mode, factsOpen, onToggleFacts }: { m: ListedMarket; mode: Mode; factsOpen: boolean; onToggleFacts: () => void }) {
  const perps = mode === "perps";
  const shell = useShell();
  const watchlist = useWatchlist();
  const watched = watchlist.includes(m.key);
  const market = m.market;
  const markAge = market?.markAgeSeconds ?? null;
  const shown = price(market?.mark ?? null);
  const priceLabel = perps ? copy.perps.markPrice : "Oracle price";
  return (
    <section className={`${styles.header} datum`} aria-label={`${m.symbol} market`}>
      <div className={styles.identity}>
        <AssetEmblem logoUrl={m.logoUrl} assetClass={m.assetClass} size={24} label={m.symbol} />
        <h1 className={styles.symbol}>
          <button type="button" className={styles.symbolButton} onClick={shell.openSearch} aria-label={`${m.symbol}, ${perps ? "perpetual" : "spot"} market. Change market`}>
            {m.symbol}
            <ChevronDown size={14} />
          </button>
        </h1>
        <button type="button" className={styles.watch} aria-pressed={watched} aria-label={watched ? `Remove ${m.symbol} from watchlist` : `Add ${m.symbol} to watchlist`} onClick={() => toggleWatchlist(m.key)}>
          <Star size={15} filled={watched} />
        </button>
      </div>

      <LayoutGroup id="trade-mode">
        <nav className="seg" aria-label="Trading mode">
          {m.pool ? (
            <Link href={`/app/trade/${m.key}?mode=spot`} aria-current={!perps ? "page" : undefined} replace scroll={false}>
              {copy.spot.tab}
              {!perps ? <motion.span layoutId="selection-fill" className="seg-fill" aria-hidden transition={TRANSITION.select} /> : null}
            </Link>
          ) : (
            <span className="seg-off" title="This market has no private pool.">{copy.spot.tab}</span>
          )}
          {market ? (
            <Link href={`/app/trade/${m.key}?mode=perps`} aria-current={perps ? "page" : undefined} replace scroll={false}>
              {copy.perps.tab}
              {perps ? <motion.span layoutId="selection-fill" className="seg-fill" aria-hidden transition={TRANSITION.select} /> : null}
            </Link>
          ) : (
            <span className="seg-off" title="This market has no private perps.">{copy.perps.tab}</span>
          )}
        </nav>
      </LayoutGroup>

      <div className={styles.priceBlock}>
        <span className={styles.price} aria-label={`${priceLabel} ${shown}`}>{shown}</span>
        <span className={styles.priceLabel}>{priceLabel}</span>
      </div>

      <div className={styles.meta}>
        {perps ? <PerpStatusPill status={market ? "ACTIVE" : "NONE"} fresh={market?.markFresh ?? null} /> : <SpotStatusPill status={m.pool ? "ACTIVE" : "NONE"} funded={m.pool?.seeded ?? false} />}
        {m.isTestFixture ? <TestTag>Test fixture</TestTag> : m.assetClass === "stock-token" ? <span className={`tag ${styles.classTag}`} data-tone="verified">Stock Token</span> : null}
        {perps ? (
          <dl className={styles.inlineFacts}>
            <div>
              <dt>{copy.perps.funding} (1h)</dt>
              <dd className="num">{market?.fundingPerSecondWad === null || !market ? "-" : fundingPerHour(market.fundingPerSecondWad)}</dd>
            </div>
            <div>
              <dt>Mark age</dt>
              <dd className={markAge !== null && markAge > 3600 ? "num warn" : "num"}>{markAge === null ? "-" : formatAge(markAge)}</dd>
            </div>
          </dl>
        ) : null}
        <button type="button" className={styles.factsToggle} aria-expanded={factsOpen} onClick={onToggleFacts}>
          Market facts
          <ChevronDown size={14} style={{ transform: factsOpen ? "rotate(180deg)" : undefined }} />
        </button>
      </div>
    </section>
  );
}
