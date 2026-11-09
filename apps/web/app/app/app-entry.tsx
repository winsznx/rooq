"use client";

import Link from "next/link";
import { useMemo, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import type { Route } from "next";
import { copy } from "@rooq/ui";
import { usePrivate } from "@/lib/private/client";
import { findListed, listedMarkets, type ListedMarket } from "@/lib/private/market-list";
import { CHAIN_CONFIG, ENV, ENV_LABEL } from "@/lib/env";
import { STAGE_META, isActive, needsAttention } from "@/lib/operations";
import { useWatchlist } from "@/lib/preferences";
import { price } from "@/lib/display";
import { LAST_MARKET_KEY } from "@/components/trade/trade-view";
import { AssetEmblem, Skeleton } from "@/components/primitives";
import { OverviewPrivate } from "@/components/private/portfolio";
import { WalletButton, useWalletState } from "@/components/wallet";
import { HideValuesToggle } from "@/components/account/summary";
import { useWalletOperations } from "@/components/ops/operation-center";
import styles from "./overview.module.css";

function readLast(): string | null {
  try {
    return window.localStorage.getItem(LAST_MARKET_KEY);
  } catch (error) {
    console.warn("last market unreadable", error);
    return null;
  }
}

function BlockHead({ title, link }: { title: string; link?: { href: Route; label: string } }) {
  return (
    <div className={styles.blockHead}>
      <h2 className={styles.blockTitle}>{title}</h2>
      {link ? <Link href={link.href}>{link.label}</Link> : null}
    </div>
  );
}

function MarketRow({ m }: { m: ListedMarket }) {
  return (
    <li>
      <Link className={styles.listRow} href={`/app/trade/${m.key}?mode=${m.market ? "perps" : "spot"}`}>
        <AssetEmblem logoUrl={m.logoUrl} assetClass={m.assetClass} size={24} label={m.symbol} />
        <strong>{m.symbol}</strong>
        <span className={styles.listRight}>
          <span className="num">{price(m.market?.mark ?? null)}</span>
          <small>{m.market ? "Mark" : "Pool"}</small>
        </span>
      </Link>
    </li>
  );
}

function Watchlist({ markets }: { markets: readonly ListedMarket[] | undefined }) {
  const keys = useWatchlist();
  const rows = (markets ?? []).filter((m) => keys.includes(m.key));
  return (
    <section className={styles.block} aria-label="Watchlist">
      <BlockHead title="Watchlist" link={{ href: "/app/markets", label: "All markets" }} />
      {rows.length > 0 ? (
        <ul className={styles.list} role="list">
          {rows.map((m) => (
            <MarketRow key={m.key} m={m} />
          ))}
        </ul>
      ) : (
        <p className={styles.clear}>Star a market to keep it here. The list is saved in this browser only.</p>
      )}
    </section>
  );
}

function Pending() {
  const ops = useWalletOperations();
  const open = ops.filter((op) => isActive(op) || needsAttention(op));
  return (
    <section className={styles.block} aria-label="Pending operations">
      <BlockHead title="Pending operations" />
      {open.length > 0 ? (
        <div>
          {open.slice(0, 4).map((op) => (
            <div key={op.id} className={styles.opRow}>
              <span>{op.title}</span>
              <span>{STAGE_META[op.stage].label}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.clear}>Nothing is in progress.</p>
      )}
    </section>
  );
}

function Resume({ markets }: { markets: readonly ListedMarket[] | undefined }) {
  const raw = useSyncExternalStore(() => () => undefined, readLast, () => null);
  const last = useMemo(() => (raw ? (JSON.parse(raw) as { key: string; mode: string }) : null), [raw]);
  const m = last ? markets ? findListed(markets, last.key) : undefined : undefined;
  if (!m) return null;
  return (
    <section className={styles.block} aria-label="Continue trading">
      <BlockHead title="Continue" />
      <ul className={styles.list} role="list">
        <li>
          <Link className={styles.listRow} href={`/app/trade/${m.key}?mode=${last?.mode === "spot" ? "spot" : "perps"}`}>
            <AssetEmblem logoUrl={m.logoUrl} assetClass={m.assetClass} size={24} label={m.symbol} />
            <strong>{`${m.symbol} ${last?.mode === "spot" ? "spot" : "perps"}`}</strong>
            <span className={styles.listRight}>
              <span className="num">{price(m.market?.mark ?? null)}</span>
            </span>
          </Link>
        </li>
      </ul>
    </section>
  );
}

/** Disconnected: the market is usable at once, the way a lending app shows rates before you connect. */
function ConnectIntro() {
  return (
    <section className={styles.intro} aria-label="Get started">
      <div className={styles.introText}>
        <h2 className={styles.introTitle}>Buy stock tokens or trade their price</h2>
        <p className={styles.introSub}>Testnet only, with test money. Your trades stay private.</p>
      </div>
      <div className={styles.introCta}>
        <WalletButton />
      </div>
    </section>
  );
}

function MarketList({ markets }: { markets: readonly ListedMarket[] | undefined }) {
  return (
    <section className={styles.block} aria-label={copy.nav.markets}>
      <BlockHead title={copy.nav.markets} link={{ href: "/app/markets", label: "See all" }} />
      {markets ? (
        <div>
          {markets.map((m) => (
            <Link key={m.key} className={styles.marketRow} href={`/app/trade/${m.key}?mode=${m.market ? "perps" : "spot"}`}>
              <AssetEmblem logoUrl={m.logoUrl} assetClass={m.assetClass} size={32} label={m.symbol} />
              <span className={styles.marketName}>
                <strong>{m.symbol}</strong>
                <span>{m.name}</span>
              </span>
              <span className="tag">{m.market && m.pool ? "Spot and perps" : m.market ? "Perps" : "Spot only"}</span>
              <span className={styles.marketPrice}>
                <span className="num">{price(m.market?.mark ?? null)}</span>
                <small>{m.market ? "Mark" : "Pool"}</small>
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <Skeleton width="60%" />
      )}
    </section>
  );
}

function Guide() {
  return (
    <section className={styles.block} aria-label="How to start">
      <BlockHead title="How to start" />
      <ul className={styles.guide} role="list">
        <li>
          <strong>Connect</strong>
          You sign once. There&apos;s nothing to write down.
        </li>
        <li>
          <strong>Add test money</strong>
          Shield test tokens from your wallet.
        </li>
        <li>
          <strong>Pick a market</strong>
          Buy the token, or trade its price.
        </li>
      </ul>
    </section>
  );
}

/** Public markets for everyone; private blocks masked until an account opens. Never invents a figure. */
export function AppEntry() {
  const { address } = useAccount();
  const { wrongChain } = useWalletState();
  const { view } = usePrivate();
  const marketList = useMemo(() => (view ? listedMarkets(view) : undefined), [view]);
  return (
    <div className={styles.page}>
      <div className={styles.topRow}>
        <h1 className="app-title">Overview</h1>
        <span className={`row ${styles.topMeta}`} style={{ "--gap": "12px" } as React.CSSProperties}>
          <span className="t-small faint">{`${ENV_LABEL[ENV]}, chain ${CHAIN_CONFIG.chainId}`}</span>
          <HideValuesToggle />
        </span>
      </div>

      {wrongChain ? <p className="notice" data-tone="warning">{copy.errors.wrongNetwork}</p> : null}
      {!address ? <ConnectIntro /> : null}

      <div className={styles.columns}>
        <div className={styles.main}>
          <OverviewPrivate />
          <MarketList markets={marketList} />
        </div>
        <aside className={styles.aside}>
          {!address ? <Guide /> : null}
          <Resume markets={marketList} />
          <Pending />
          <Watchlist markets={marketList} />
        </aside>
      </div>
    </div>
  );
}
