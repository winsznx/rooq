"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Route } from "next";
import { copy } from "@rooq/ui";
import { docsUrl } from "@rooq/config";
import { formatAge } from "@rooq/sdk";
import { ENV, ENV_LABEL } from "@/lib/env";
import { useNow } from "@/lib/use-now";
import { usePrivate } from "@/lib/private/client";
import { AccountSheet, LockWatcher, WalletLink } from "../private/account";
import { WalletTxBridge } from "../private/wallet-bridge";
import { BrandMark } from "../public/brand-mark";
import { Dialog } from "../feedback/dialog";
import {
  Activity,
  Create,
  Docs,
  Liquidity,
  Maker,
  Markets,
  More,
  Overview,
  Portfolio,
  Pulse,
  Search,
  Settings,
  SwapArrows,
  Trade,
} from "../icons";
import { ThemeToggle } from "../theme-toggle";
import { WalletButton, useWalletState } from "../wallet";
import { OperationCenter } from "../ops/operation-center";
import { MarketSwitcher } from "./market-switcher";
import styles from "./shell.module.css";

interface NavItem {
  readonly href: Route;
  readonly label: string;
  readonly icon: (p: { size?: number }) => ReactNode;
  readonly match: (path: string) => boolean;
  /** Opens on another host instead of routing inside the app. */
  readonly external?: string;
}

const PRIMARY: readonly NavItem[] = [
  { href: "/app", label: "Overview", icon: Overview, match: (p) => p === "/app" },
  { href: "/app/markets", label: copy.nav.markets, icon: Markets, match: (p) => p.startsWith("/app/markets") || p.startsWith("/app/assets") },
  { href: "/app/trade", label: copy.nav.trade, icon: Trade, match: (p) => p.startsWith("/app/trade") || p.startsWith("/app/positions") },
  { href: "/app/swap", label: copy.nav.swap, icon: SwapArrows, match: (p) => p.startsWith("/app/swap") },
  { href: "/app/portfolio", label: copy.nav.portfolio, icon: Portfolio, match: (p) => p.startsWith("/app/portfolio") },
  { href: "/app/liquidity", label: copy.nav.liquidity, icon: Liquidity, match: (p) => p.startsWith("/app/liquidity") },
  { href: "/app/makers", label: copy.nav.makers, icon: Maker, match: (p) => p.startsWith("/app/makers") },
  { href: "/app/create", label: copy.nav.create, icon: Create, match: (p) => p.startsWith("/app/create") },
];

const SECONDARY: readonly NavItem[] = [
  { href: "/app/activity", label: copy.nav.activity, icon: Activity, match: (p) => p.startsWith("/app/activity") },
  { href: "/status", label: copy.system.status, icon: Pulse, match: (p) => p.startsWith("/status") },
  { href: "/docs", label: copy.nav.docs, icon: Docs, match: () => false, external: docsUrl() },
  { href: "/app/settings", label: copy.nav.settings, icon: Settings, match: (p) => p.startsWith("/app/settings") },
];

const MOBILE_TABS: readonly NavItem[] = PRIMARY.filter((i) => ["/app", "/app/markets", "/app/trade", "/app/portfolio"].includes(i.href));
const MOBILE_MORE: readonly NavItem[] = [...PRIMARY.filter((i) => !MOBILE_TABS.includes(i)), ...SECONDARY];

interface ShellApi {
  readonly openMenu: () => void;
  readonly openSearch: () => void;
}
const ShellContext = createContext<ShellApi>({ openMenu: () => undefined, openSearch: () => undefined });
export const useShell = () => useContext(ShellContext);

export function Wordmark() {
  return (
    <Link href="/" className={styles.wordmark} aria-label="Rooq home">
      <BrandMark variant="horizontal" className={styles.logoWide} />
      <BrandMark variant="wordmark" className={styles.logoCompact} />
      <BrandMark variant="micro" className={styles.logoMicro} />
    </Link>
  );
}

function NavLink({ item, path, compact }: { item: NavItem; path: string; compact: boolean }) {
  const active = item.match(path);
  const Icon = item.icon;
  if (item.external) {
    return (
      <a href={item.external} className={styles.navLink} title={compact ? item.label : undefined}>
        <Icon size={20} />
        <span className={styles.navLabel}>{item.label}</span>
      </a>
    );
  }
  return (
    <Link href={item.href} className={styles.navLink} aria-current={active ? "page" : undefined} title={compact ? item.label : undefined}>
      <Icon size={20} />
      <span className={styles.navLabel}>{item.label}</span>
    </Link>
  );
}

function StatusBar() {
  const { view, offline } = usePrivate();
  const { address, isConnected, wrongChain } = useWalletState();
  const now = useNow();
  const block = view && view.sync.head !== null ? { number: view.sync.head, timestamp: view.chainNow ?? 0n } : null;
  const age = block ? now - Number(block.timestamp) : null;
  return (
    <footer className={styles.statusBar} aria-label="Network status">
      <span className="row" style={{ "--gap": "6px" } as React.CSSProperties}>
        <span className={styles.dot} data-ok={block ? "true" : "false"} aria-hidden />
        {ENV_LABEL[ENV]}
        <span className="tag" data-tone="test">
          {copy.system.beta}
        </span>
      </span>
      <span className="num">{block ? `Block ${block.number.toString()}` : offline ? "Private services offline" : "Connecting"}</span>
      {block && age !== null && age >= 0 ? <span className="faint">{`Last block ${formatAge(age)}`}</span> : null}
      <span className={wrongChain ? "warn" : undefined}>{!isConnected ? "Wallet not connected" : wrongChain ? "Wrong network" : `Wallet ${address?.slice(0, 6)}…${address?.slice(-4)}`}</span>
      <span className={styles.statusRight}>
        <Link href="/status">{copy.system.status}</Link>
        <span className="faint">build {process.env.NEXT_PUBLIC_BUILD_ID ?? "dev"}</span>
      </span>
    </footer>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/app";
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [docked, setDocked] = useState(false);
  const tradeRoute = path.startsWith("/app/trade");
  const openMenu = useCallback(() => setMoreOpen(true), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const api = useMemo(() => ({ openMenu, openSearch }), [openMenu, openSearch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ShellContext.Provider value={api}>
    <div className={styles.shell} data-trade={tradeRoute} data-dock={docked}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <Wordmark />
          <span className="tag" data-tone="test">
            {copy.system.beta}
          </span>
        </div>
        <button type="button" className={styles.search} onClick={() => setSearchOpen(true)} aria-keyshortcuts="Meta+K Control+K">
          <Search size={18} />
          <span className={styles.searchLabel}>Search markets</span>
          <kbd className={styles.kbd} aria-hidden="true">
            ⌘K
          </kbd>
        </button>
        <div className={styles.headerRight}>
          <OperationCenter onDockChange={setDocked} />
          <span className={styles.themeSlot}>
            <ThemeToggle />
          </span>
          <WalletButton compact />
        </div>
      </header>
      <p className={styles.testnetBanner} role="note">
        {copy.landing.testnetBanner}
      </p>

      <nav className={styles.rail} aria-label="Primary">
        <div className={styles.navGroup}>
          {PRIMARY.map((item) => (
            <NavLink key={item.href} item={item} path={path} compact={tradeRoute} />
          ))}
        </div>
        <div className={styles.navGroup}>
          {SECONDARY.map((item) => (
            <NavLink key={item.href} item={item} path={path} compact={tradeRoute} />
          ))}
        </div>
      </nav>

      <main id="main" className={styles.main} tabIndex={-1}>
        {children}
      </main>

      <StatusBar />

      <nav className={styles.tabBar} aria-label="Primary mobile">
        {MOBILE_TABS.map((item) => {
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className={styles.tab} aria-current={item.match(path) ? "page" : undefined}>
              <Icon size={20} />
              <span>{item.label}</span>
            </Link>
          );
        })}
        <button type="button" className={styles.tab} onClick={() => setMoreOpen(true)} aria-haspopup="dialog">
          <More size={20} />
          <span>More</span>
        </button>
      </nav>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen} title="More">
        <div className={styles.moreList}>
          {MOBILE_MORE.map((item) => {
            const Icon = item.icon;
            if (item.external) {
              return (
                <a key={item.href} href={item.external} className={styles.moreLink} onClick={() => setMoreOpen(false)}>
                  <Icon size={20} />
                  {item.label}
                </a>
              );
            }
            return (
              <Link key={item.href} href={item.href} className={styles.moreLink} onClick={() => setMoreOpen(false)}>
                <Icon size={20} />
                {item.label}
              </Link>
            );
          })}
        </div>
      </Dialog>
      <MarketSwitcher open={searchOpen} onOpenChange={setSearchOpen} />
      <WalletLink />
      <WalletTxBridge />
      <AccountSheet />
      <LockWatcher />
    </div>
    </ShellContext.Provider>
  );
}
