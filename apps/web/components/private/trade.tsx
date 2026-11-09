"use client";

import { useState } from "react";
import { formatFixed, parseDecimal } from "@rooq/sdk";
import { Segmented, StateBlock } from "@/components/primitives";
import { AmountField } from "@/components/funds/amount-field";
import type { ListedMarket } from "@/lib/private/market-list";
import { useSlippageBps } from "@/lib/preferences";
import { fee as feeOf, liquidationPrice, margin as marginOf, slip } from "@/lib/private/math";
import { ensureAccount, usePrivate, wallet } from "@/lib/private/client";
import type { LockView, MarketView, PrivateView } from "@/lib/private/types";
import { amountText, balanceOf, countdown, ExpiryPicker, IconRow, Line, PrivateUnavailable, PV, px, qty, RelayLabel, styles, tokenOf, useView, withAccount } from "./kit";
import { PositionCard, PositionDialog } from "./positions";

/** Chart lines for the open position, only while the account is open and values are shown. */
export function usePrivateLevels(market: MarketView | null, hidden: boolean) {
  const view = useView();
  if (!market || !view?.unlocked || hidden) return [];
  const p = view.positions.find((x) => x.market === market.id && x.status === "open" && x.side === "taker");
  if (!p) return [];
  const liq = liquidationPrice(p.isShort, p.size, p.entry, p.takerMargin, market.mmrWad, market.scale);
  const out: { key: string; label: string; price: number; tone: "entry" | "liquidation" }[] = [{ key: "entry", label: "Entry", price: Number(p.entry) / 1e18, tone: "entry" }];
  if (liq !== null) out.push({ key: "liq", label: "Est. liq.", price: liq, tone: "liquidation" });
  return out;
}

export function PrivatePerpsTicket({ m }: { m: ListedMarket }) {
  const view = useView();
  if (!view) return <PrivateUnavailable />;
  if (!m.market) return <StateBlock kind="empty" title={`Private perps aren't open for ${m.symbol} yet`} body="Market data stays available here." />;
  return <Ticket key={m.market.id.toString()} view={view} m={m.market} symbol={m.symbol} routeKey={m.key} />;
}

function Ticket({ view, m, symbol, routeKey }: { view: PrivateView; m: MarketView; symbol: string; routeKey: string }) {
  const { status } = usePrivate();
  const slippageBps = useSlippageBps();
  const [side, setSide] = useState<"long" | "short">("long");
  const [sizeText, setSizeText] = useState("");
  const [marginText, setMarginText] = useState("");
  const [expiry, setExpiry] = useState(3_600n);
  const [note, setNote] = useState<string | null>(null);
  const [repriced, setRepriced] = useState<{ isShort: boolean; mark: bigint } | null>(null);
  const [checking, setChecking] = useState(false);
  const token = tokenOf(view, m.collateral);
  const unlocked = status === "unlocked";
  const size = parseDecimal(sizeText, 18);
  const marginInput = parseDecimal(marginText, token.decimals);
  const isShort = side === "short";
  const awaitingConfirm = repriced !== null && repriced.isShort === isShort;
  const mark = awaitingConfirm ? repriced.mark : m.mark;
  const limit = mark ? slip(mark, isShort, BigInt(slippageBps)) : null;
  const im = mark && size ? marginOf(size, mark, m.imrWad, m.scale) : null;
  const fee = limit && size ? feeOf(size, limit, m.takerFeeBps, m.scale) : null;
  const required = im !== null && fee !== null ? im + fee : null;
  const free = balanceOf(view, m.collateral);
  const overBalance = unlocked && marginInput !== null && marginInput > free;
  const ready = size !== null && size > 0n && size <= m.maxPairSize && marginInput !== null && required !== null && marginInput >= required && !overBalance && limit !== null;
  const go = async () => {
    if (!ready || size === null || marginInput === null || limit === null) return;
    setNote(null);
    setChecking(true);
    let latest: bigint | null;
    try {
      latest = await wallet.readMark(m.id);
    } catch {
      setNote("Rooq couldn't read the latest price, so nothing was sent. Try again.");
      return;
    } finally {
      setChecking(false);
    }
    if (latest === null) {
      setNote("The price is out of date. New positions are blocked until it refreshes.");
      return;
    }
    if (isShort ? latest < limit : latest > limit) {
      setRepriced({ isShort, mark: latest });
      return;
    }
    setRepriced(null);
    const latestLimit = slip(latest, isShort, BigInt(slippageBps));
    // Never worse than the price on screen, which is what the user agreed to.
    const orderLimit = (isShort ? latestLimit > limit : latestLimit < limit) ? latestLimit : limit;
    void wallet.start({ t: "perpOpen", market: m.id, isShort, size, margin: marginInput, limit: orderLimit, expiry }, `Open ${side} ${formatFixed(size, 18, 4)} ${symbol}`, `/app/trade/${routeKey}?mode=perps`).then(() => {
      setNote("Started. Operations tracks it while you move around.");
      setSizeText("");
      setMarginText("");
    });
  };
  return (
    <div className={styles.stack}>
      <Segmented<"long" | "short"> value={side} onChange={setSide} label="Side" block options={[{ value: "long", label: "Long" }, { value: "short", label: "Short" }]} />
      <AmountField label="Size" value={sizeText} onChange={setSizeText} decimals={18} unit={symbol} error={size !== null && size > m.maxPairSize ? `Largest fill here is ${qty(m.maxPairSize)}` : null} />
      <AmountField label="Margin" value={marginText} onChange={setMarginText} decimals={token.decimals} unit={token.symbol} balanceLabel={unlocked ? "Private balance" : undefined} balance={free} error={marginInput !== null && required !== null && marginInput < required ? `Needs at least ${amountText(view, m.collateral, required)}` : overBalance ? "More than your private balance." : null} />
      <div className={styles.stack}>
        <span className="field-label"><span>If no maker matches by</span></span>
        <ExpiryPicker value={expiry} onChange={setExpiry} />
      </div>
      <div>
        <Line label="Worst price you accept">{limit ? px(limit) : "Unavailable"}</Line>
        <Line label="Initial margin">{im !== null ? amountText(view, m.collateral, im, 2) : "-"}</Line>
        <Line label="Fee, at most">{fee !== null ? amountText(view, m.collateral, fee, 2) : "-"}</Line>
      </div>
      <p className={styles.note}>Rooq locks your margin privately and waits for a maker. A match isn&apos;t guaranteed. If nothing matches by expiry, your funds come back.</p>
      <RelayLabel />
      {!m.markFresh ? <p className="notice" data-tone="warning" role="alert">The price is out of date. New positions are blocked until it refreshes.</p> : null}
      {note ? <p className="notice" role="status">{note}</p> : null}
      {awaitingConfirm && limit !== null ? (
        <div className="notice" data-tone="warning" role="alert" data-testid="price-moved">
          <p>The price moved to {px(repriced.mark)}. Your worst price is now {px(limit)}. Nothing has been sent.</p>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRepriced(null)}>Keep editing</button>
        </div>
      ) : null}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!ready || !m.markFresh || checking} onClick={() => withAccount(go)}>{awaitingConfirm ? "Confirm new price" : "Place order"}</button>
      {!unlocked ? <p className={styles.hint}>You&apos;ll connect a wallet and sign once. Nothing to write down.</p> : null}
    </div>
  );
}

export function LockRow({ l, view }: { l: LockView; view: PrivateView }) {
  const left = view.chainNow !== null ? l.expiry - view.chainNow : 0n;
  const m = view.markets.find((x) => x.id === l.market);
  return (
    <div className={styles.rowLine} data-testid="lock-row" data-status={l.status}>
      <span className={styles.row}>
        <IconRow view={view} icons={l.role === "taker" || l.role === "maker" ? [{ market: l.market }] : [{ asset: l.asset }]} />
        {l.role === "taker" ? `${l.isShort ? "Short" : "Long"} ${m?.label ?? l.market} lock` : l.role === "maker" ? `Maker backing, ${m?.label ?? l.market}` : l.role === "swap" ? "Swap intent" : "Liquidity lock"}
      </span>
      <span className={styles.row}>
        <PV>{amountText(view, l.asset, l.amount, 2)}</PV>
        {l.status === "queued" ? <span className={styles.badge}>Entering the tree</span> : null}
        {l.status === "live" ? <span className={styles.badge}>{`Expires in ${countdown(left)}`}</span> : null}
        {l.status === "expired" ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void wallet.start({ t: "release", lock: l.id }, "Refund expired lock", "/app/portfolio")}>Refund</button>
        ) : null}
      </span>
    </div>
  );
}

/** Positions and open locks in the trade tray. Masked until the account opens; nothing public is shown instead. */
export function PrivateTray({ market, kind }: { market: MarketView | null; kind: "positions" | "locks" }) {
  const view = useView();
  const { status } = usePrivate();
  const [managing, setManaging] = useState<string | null>(null);
  if (status !== "unlocked" || !view) {
    return <StateBlock kind="locked" title="Your positions are private" body="Open your account to see them here." actions={<button type="button" className="btn btn-sm" onClick={() => void ensureAccount()}>Open account</button>} />;
  }
  if (kind === "locks") {
    const locks = view.locks.filter((l) => (l.role === "taker" || l.role === "maker") && (!market || l.market === market.id) && (l.status === "live" || l.status === "queued" || l.status === "expired"));
    return locks.length === 0 ? <StateBlock kind="empty" title="Nothing waiting for a match" /> : <div className={styles.stack} style={{ padding: 12 }}>{locks.map((l) => <LockRow key={l.id} l={l} view={view} />)}</div>;
  }
  const positions = view.positions.filter((p) => (!market || p.market === market.id) && p.status === "open");
  return (
    <div className={styles.stack} style={{ padding: 12 }}>
      {positions.length === 0 ? <StateBlock kind="empty" title="No open position in this market" /> : positions.map((p) => <PositionCard key={p.id} p={p} onOpen={() => setManaging(p.id)} />)}
      <PositionDialog id={managing} onClose={() => setManaging(null)} />
    </div>
  );
}
