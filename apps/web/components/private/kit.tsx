"use client";

import { useMemo, type ReactNode } from "react";
import type { Hex } from "viem";
import { formatFixed } from "@rooq/sdk";
import { HideValuesToggle } from "@/components/account/summary";
import { AssetEmblem, Skeleton } from "@/components/primitives";
import { useHideValues } from "@/lib/preferences";
import { marketArtwork, tokenArtwork } from "@/lib/private/assets";
import { ensureAccount, usePrivate } from "@/lib/private/client";
import type { MarketView, OpIcon, PrivateView, TokenInfo } from "@/lib/private/types";
import styles from "./private.module.css";

export { styles };

export function useView(): PrivateView | null {
  return usePrivate().view;
}

export function tokenOf(view: PrivateView, asset: Hex | string): TokenInfo {
  const low = asset.toLowerCase();
  return view.tokens.find((t) => t.address.toLowerCase() === low) ?? { address: asset as Hex, symbol: `${asset.slice(0, 6)}…`, name: "Unknown token", decimals: 18 };
}

export function amountText(view: PrivateView, asset: Hex | string, value: bigint, precision = 4): string {
  const t = tokenOf(view, asset);
  return `${formatFixed(value, t.decimals, precision)} ${t.symbol}`;
}

export function balanceOf(view: PrivateView, asset: Hex | string): bigint {
  return view.balances.find((b) => b.asset.toLowerCase() === asset.toLowerCase())?.free ?? 0n;
}

export const px = (v: bigint | null | undefined): string => (v === null || v === undefined ? "Unavailable" : formatFixed(v, 18, 2));
export const qty = (v: bigint | null | undefined, precision = 4): string => (v === null || v === undefined ? "Unavailable" : formatFixed(v, 18, precision));

/** A private figure: masked with no account or when locked, otherwise behind the eye toggle. */
export function PV({ children, plain = false }: { children: ReactNode; plain?: boolean }) {
  const hidden = useHideValues();
  const { status } = usePrivate();
  const masked = hidden || status !== "unlocked";
  return (
    <span className={styles.glass} data-masked={masked} data-plain={plain}>
      {masked ? "••••••" : children}
    </span>
  );
}

export function TokenIcon({ view, asset, size = 24 }: { view: PrivateView; asset: string; size?: 24 | 32 | 40 }) {
  const a = tokenArtwork(tokenOf(view, asset));
  return <AssetEmblem logoUrl={a.logoUrl} assetClass={a.assetClass} size={size} label={a.label} />;
}

export function MarketIcon({ market, size = 24 }: { market: bigint; size?: 24 | 32 | 40 }) {
  const a = marketArtwork(market);
  return <AssetEmblem logoUrl={a.logoUrl} assetClass={a.assetClass} size={size} label={a.label} />;
}

export function TokenPair({ view, token0, token1 }: { view: PrivateView; token0: string; token1: string }) {
  return (
    <span className={styles.iconPair}>
      <TokenIcon view={view} asset={token0} />
      <TokenIcon view={view} asset={token1} />
    </span>
  );
}

export function IconRow({ view, icons }: { view: PrivateView; icons: readonly OpIcon[] }) {
  if (icons.length === 0) return null;
  return (
    <span className={styles.iconPair}>
      {icons.map((i, n) => (i.market !== undefined ? <MarketIcon key={n} market={i.market} /> : i.asset ? <TokenIcon key={n} view={view} asset={i.asset} /> : null))}
    </span>
  );
}

/** A symbol with its logo, for selectors and rows. */
export function TokenLabel({ view, asset }: { view: PrivateView; asset: string }) {
  return (
    <span className={styles.tokenLabel}>
      <TokenIcon view={view} asset={asset} />
      {tokenOf(view, asset).symbol}
    </span>
  );
}

/** Runs an action, opening account setup first if it's needed. What the person typed stays where it is. */
export const withAccount = (action: () => void | Promise<void>) => {
  void ensureAccount().then((ok) => {
    if (ok) void action();
  });
};

/** No market data yet: quietly loading, or a true "unreachable" once the worker has tried. */
export function PrivateUnavailable() {
  const { offline } = usePrivate();
  if (!offline) return <Skeleton width="60%" height={16} />;
  return <p className="notice" data-tone="warning" role="alert">The private services can&apos;t be reached, so this can&apos;t be shown right now. Nothing falls back to a public path.</p>;
}

export function Offline({ title }: { title: string }) {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{title}</h1>
      <PrivateUnavailable />
    </div>
  );
}

export function Eye() {
  return <HideValuesToggle />;
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={styles.head}>
      <div className={styles.stack}>
        <h1 className={styles.title}>{title}</h1>
        {sub ? <p className={styles.lede}>{sub}</p> : null}
      </div>
      <div className={styles.row}>
        {actions}
        <Eye />
      </div>
    </div>
  );
}

export function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.rowLine}>
      <span>{label}</span>
      <span className={styles.rowValue}>{children}</span>
    </div>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.stat}>
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

const SYNC_COPY: Record<string, string> = {
  READ_UNAVAILABLE: "The private read service isn't answering",
  RELAYER_UNAVAILABLE: "The relayer isn't answering",
  NETWORK_UNREACHABLE: "The network can't be reached",
  ROOT_MISMATCH: "The read service disagreed with the tree this wallet built",
  SYNC_FAILED: "This wallet couldn't update",
};

/** Accepted root, block and freshness (DATA-02). A failed refresh keeps the last values but says they are stale. */
export function SyncBadge() {
  const view = useView();
  if (!view) return null;
  const { sync } = view;
  if (sync.error) return <span className={styles.badge} data-tone="bad">{`Stale: ${SYNC_COPY[sync.error] ?? sync.error}`}</span>;
  const lag = sync.queueLength - sync.processed;
  return (
    <span className={styles.badge} data-tone="ok" title={sync.root ?? undefined}>
      {`Synced to block ${sync.head?.toString() ?? "?"}${lag > 0 ? `, ${lag} entries entering the tree` : ""}`}
    </span>
  );
}

export function ServiceNotice() {
  const view = useView();
  if (!view?.sync.error) return null;
  return (
    <p className="notice" data-tone="warning" role="alert">
      {`${SYNC_COPY[view.sync.error] ?? view.sync.error}. Figures below are from the last good read. Private actions won't run until this clears, and nothing falls back to a public path.`}
    </p>
  );
}

export function Unavailable({ what }: { what: string }) {
  return (
    <p className="notice" role="status">
      {`${what} is unavailable until your wallet finishes reading the chain.`}
    </p>
  );
}

export function RelayLabel() {
  return <span className="tag" data-tone="test" style={{ justifySelf: "start" }}>TEST price relay, single operator</span>;
}

export function useMarket(id: bigint): MarketView | null {
  const view = useView();
  return useMemo(() => view?.markets.find((m) => m.id === id) ?? null, [view, id]);
}

export function countdown(seconds: bigint): string {
  const s = seconds < 0n ? 0n : seconds;
  const d = s / 86_400n;
  const h = (s % 86_400n) / 3_600n;
  const m = (s % 3_600n) / 60n;
  if (d > 0n) return `${d}d ${h}h`;
  if (h > 0n) return `${h}h ${m}m`;
  return `${m}m ${s % 60n}s`;
}

export const EXPIRIES = [
  { label: "15 min", seconds: 900n },
  { label: "1 hour", seconds: 3_600n },
  { label: "24 hours", seconds: 86_400n },
] as const;

export function ExpiryPicker({ value, onChange }: { value: bigint; onChange: (v: bigint) => void }) {
  return (
    <div className={styles.row}>
      {EXPIRIES.map((e) => (
        <button key={e.label} type="button" className="chip" aria-pressed={value === e.seconds} onClick={() => onChange(e.seconds)}>
          {e.label}
        </button>
      ))}
    </div>
  );
}
