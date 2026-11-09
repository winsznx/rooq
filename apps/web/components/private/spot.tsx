"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Hex } from "viem";
import { formatFixed, parseDecimal } from "@rooq/sdk";
import { AmountField } from "@/components/funds/amount-field";
import { Segmented, StateBlock } from "@/components/primitives";
import { useSlippageBps } from "@/lib/preferences";
import { usePrivate, wallet } from "@/lib/private/client";
import { PRIVATE_READ_URL } from "@/lib/private/config";
import type { PoolView, PrivateView } from "@/lib/private/types";
import type { ListedMarket } from "@/lib/private/market-list";
import { amountText, balanceOf, ExpiryPicker, Line, Offline, PageHead, PrivateUnavailable, ServiceNotice, styles, SyncBadge, TokenLabel, tokenOf, useView, withAccount } from "./kit";
import { LockRow } from "./trade";

interface Route {
  readonly pool: PoolView;
  readonly second: PoolView | null;
  readonly via: Hex | null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A direct pool if one exists, else one intermediate hop. */
export function findRoute(pools: readonly PoolView[], from: Hex, to: Hex): Route | null {
  const direct = pools.find((p) => (same(p.token0, from) && same(p.token1, to)) || (same(p.token1, from) && same(p.token0, to)));
  if (direct) return { pool: direct, second: null, via: null };
  for (const a of pools.filter((p) => same(p.token0, from) || same(p.token1, from))) {
    const mid = same(a.token0, from) ? a.token1 : a.token0;
    const b = pools.find((p) => p.id !== a.id && ((same(p.token0, mid) && same(p.token1, to)) || (same(p.token1, mid) && same(p.token0, to))));
    if (b) return { pool: a, second: b, via: mid };
  }
  return null;
}

interface Quote {
  readonly amountOut: bigint;
  readonly priceImpactBps: number;
  readonly hops: number;
}

export class QuoteRefused extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

export async function fetchQuote(pool: bigint, secondPool: bigint, assetIn: Hex, amountIn: bigint, signal?: AbortSignal): Promise<Quote> {
  const res = await fetch(`${PRIVATE_READ_URL}/v1/spot/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: pool.toString(), secondPool: secondPool.toString(), amountIn: amountIn.toString(), assetIn }), signal });
  const json = (await res.json()) as { amountOut?: string; priceImpactBps?: number; hops?: number; reasonCode?: string; message?: string };
  if (!res.ok || json.amountOut === undefined) throw new QuoteRefused(json.reasonCode ?? "QUOTE_UNAVAILABLE", json.message ?? "No quote right now.");
  return { amountOut: BigInt(json.amountOut), priceImpactBps: json.priceImpactBps ?? 0, hops: json.hops ?? 1 };
}

export function SwapForm({ view, initialFrom, initialTo, lockPair }: { view: PrivateView; initialFrom?: Hex; initialTo?: Hex; lockPair?: boolean }) {
  const { status } = usePrivate();
  const slippageBps = useSlippageBps();
  const assets = useMemo(() => view.tokens.filter((t) => view.pools.some((p) => same(p.token0, t.address) || same(p.token1, t.address))), [view.tokens, view.pools]);
  const [fromAddr, setFrom] = useState<Hex | null>(initialFrom ?? null);
  const [toAddr, setTo] = useState<Hex | null>(initialTo ?? null);
  const [text, setText] = useState("");
  const [expiry, setExpiry] = useState(3_600n);
  const [note, setNote] = useState<string | null>(null);
  const unlocked = status === "unlocked";
  const from = fromAddr ?? assets[0]?.address ?? null;
  const to = toAddr ?? assets.find((t) => t.address !== from)?.address ?? null;
  const fromToken = from ? tokenOf(view, from) : null;
  const amount = fromToken ? parseDecimal(text, fromToken.decimals) : null;
  const route = from && to && from !== to ? findRoute(view.pools.filter((p) => p.seeded), from, to) : null;
  const quote = useQuery({
    queryKey: ["spot-quote", route?.pool.id.toString(), route?.second?.id.toString() ?? "0", from, amount?.toString()],
    queryFn: ({ signal }) => fetchQuote(route!.pool.id, route!.second?.id ?? 0n, from!, amount!, signal),
    enabled: route !== null && amount !== null && amount > 0n,
    retry: false,
    refetchInterval: 15_000,
  });
  const minOut = quote.data ? (quote.data.amountOut * BigInt(10_000 - slippageBps)) / 10_000n : null;
  const free = from ? balanceOf(view, from) : 0n;
  const overBalance = unlocked && amount !== null && amount > free;
  const go = () => {
    if (!from || !to || !route || !quote.data || minOut === null || amount === null || !fromToken) return;
    setNote(null);
    void wallet.start({ t: "swap", pool: route.pool.id, secondPool: route.second?.id ?? 0n, assetIn: from, amountIn: amount, minOut, expiry, estimatedOut: quote.data.amountOut }, `Swap ${formatFixed(amount, fromToken.decimals, 4)} ${fromToken.symbol} for ${tokenOf(view, to).symbol}`, "/app/swap").then(() => {
      setText("");
      setNote("Started. It settles when the operator fills it, or refunds at expiry.");
    });
  };
  const impact = quote.data?.priceImpactBps ?? null;
  const flip = () => {
    setFrom(to);
    setTo(from);
    setText("");
  };
  return (
    <div className={styles.stack}>
      {assets.length === 0 ? <StateBlock kind="empty" title="No swap pools in this deployment" /> : null}
      <div className={styles.stack}>
        <span className="field-label"><span>From</span></span>
        {lockPair && from ? (
          <div className={styles.between}><TokenLabel view={view} asset={from} /><button type="button" className="btn btn-sm" onClick={flip}>Switch</button></div>
        ) : (
          <Segmented<string> value={from ?? ""} onChange={(v) => setFrom(v as Hex)} label="From" options={assets.map((t) => ({ value: t.address, label: <TokenLabel view={view} asset={t.address} /> }))} />
        )}
        <AmountField label="Amount" value={text} onChange={setText} decimals={fromToken?.decimals ?? 18} unit={fromToken?.symbol ?? ""} balanceLabel={unlocked ? "Private balance" : undefined} balance={free} onMax={unlocked && fromToken ? () => setText(formatFixed(free, fromToken.decimals, fromToken.decimals)) : undefined} />
        <span className="field-label"><span>To</span></span>
        {lockPair && to ? <TokenLabel view={view} asset={to} /> : <Segmented<string> value={to ?? ""} onChange={(v) => setTo(v as Hex)} label="To" options={assets.filter((t) => t.address !== from).map((t) => ({ value: t.address, label: <TokenLabel view={view} asset={t.address} /> }))} />}
      </div>
      <ExpiryPicker value={expiry} onChange={setExpiry} />
      <div>
        <Line label="Route">{route ? (route.via ? `${fromToken?.symbol} to ${tokenOf(view, route.via).symbol} to ${to ? tokenOf(view, to).symbol : ""}` : "Direct") : "No liquidity for this pair yet"}</Line>
        <Line label="You receive, est.">{quote.data && to ? amountText(view, to, quote.data.amountOut) : quote.isError ? (quote.error instanceof QuoteRefused ? quote.error.reason : "Unavailable") : "-"}</Line>
        <Line label="Minimum you accept">{minOut !== null && to ? amountText(view, to, minOut) : "-"}</Line>
        <Line label="Price impact">{impact !== null ? `${(impact / 100).toFixed(2)}%` : "-"}</Line>
      </div>
      <p className={styles.note}>The quote is an estimate. Reserves are private, so the quoting service returns a rounded figure. The minimum is what binds.</p>
      {note ? <p className="notice" role="status">{note}</p> : null}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!quote.data || amount === null || amount <= 0n || overBalance} onClick={() => withAccount(go)}>Swap</button>
      {!unlocked ? <p className={styles.hint}>You&apos;ll connect a wallet and sign once. Nothing to write down.</p> : null}
    </div>
  );
}

/** Spot ticket on the trading page: the listed market's private pool, base against collateral. */
export function PrivateSpotTicket({ m }: { m: ListedMarket }) {
  const view = useView();
  if (!view) return <PrivateUnavailable />;
  const pool = m.pool;
  if (!pool) return <StateBlock kind="empty" title={`Private spot isn't open for ${m.symbol} yet`} body="Market data stays available here." />;
  return <SwapForm key={pool.id.toString()} view={view} initialFrom={pool.token0} initialTo={pool.token1} lockPair />;
}

function SwapBody() {
  const view = useView();
  if (!view) return <Offline title="Private swap" />;
  const pending = view.locks.filter((l) => l.role === "swap" && (l.status === "live" || l.status === "queued" || l.status === "expired"));
  return (
    <div className={styles.page}>
      <PageHead title="Private swap" sub="Your trade, your wallet and the amounts stay private. The operator fills it inside the minimum you set, or it refunds at expiry." actions={<SyncBadge />} />
      <ServiceNotice />
      <div className={styles.split}>
        <section className={styles.card} aria-label="Swap"><SwapForm view={view} /></section>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Open intents</h2>
          {!view.unlocked ? <p className={styles.note}>Your intents are private. Open your account to see them.</p> : pending.length === 0 ? <p className={styles.note}>Nothing waiting. Unfilled swaps return to your private balance at expiry.</p> : pending.map((l) => <LockRow key={l.id} l={l} view={view} />)}
        </section>
      </div>
    </div>
  );
}

export function PrivateSwap() {
  return <SwapBody />;
}

export function poolName(view: PrivateView, p: PoolView): string {
  return `${tokenOf(view, p.token0).symbol} / ${tokenOf(view, p.token1).symbol}`;
}
