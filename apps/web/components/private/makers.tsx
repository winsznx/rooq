"use client";

import { useState } from "react";
import { parseDecimal } from "@rooq/sdk";
import { AmountField } from "@/components/funds/amount-field";
import { Segmented, StateBlock } from "@/components/primitives";
import { usePrivate, wallet } from "@/lib/private/client";
import type { MarketView } from "@/lib/private/types";
import { amountText, balanceOf, ExpiryPicker, Line, MarketIcon, Offline, PageHead, PV, qty, ServiceNotice, styles, SyncBadge, tokenOf, useView, withAccount } from "./kit";
import { PositionCard, PositionDialog } from "./positions";
import { LockRow } from "./trade";

function BackingForm({ markets }: { markets: readonly MarketView[] }) {
  const view = useView()!;
  const { status } = usePrivate();
  const unlocked = status === "unlocked";
  const [marketId, setMarketId] = useState(markets[0]!.id.toString());
  const m = markets.find((x) => x.id.toString() === marketId) ?? markets[0]!;
  const t = tokenOf(view, m.collateral);
  const [amount, setAmount] = useState("");
  const [maxSize, setMaxSize] = useState("");
  const [spread, setSpread] = useState("20");
  const [closeSpread, setCloseSpread] = useState("30");
  const [expiry, setExpiry] = useState(86_400n);
  const [note, setNote] = useState<string | null>(null);
  const backing = parseDecimal(amount, t.decimals);
  const size = parseDecimal(maxSize, 18);
  const spreadBps = /^\d+$/.test(spread) ? BigInt(spread) : null;
  const closeBps = /^\d+$/.test(closeSpread) ? BigInt(closeSpread) : null;
  const free = balanceOf(view, m.collateral);
  const ok = backing !== null && backing > 0n && (!unlocked || backing <= free) && size !== null && size > 0n && size <= m.maxPairSize && spreadBps !== null && closeBps !== null;
  const go = () => {
    if (!ok || backing === null || size === null || spreadBps === null || closeBps === null) return;
    void wallet.start({ t: "makerLock", market: m.id, spreadBps, maxSize: size, closeSpreadBps: closeBps, amount: backing, expiry }, `Back ${m.label}`, "/app/makers").then(() => {
      setAmount("");
      setNote("Started. Once it enters the tree it can back takers until expiry.");
    });
  };
  return (
    <section className={styles.card} aria-label="Post backing">
      <h2 className={styles.cardTitle}>Post private backing</h2>
      <Segmented<string> value={marketId} onChange={setMarketId} label="Market" options={markets.map((x) => ({ value: x.id.toString(), label: <span className={styles.tokenLabel}><MarketIcon market={x.id} />{x.label}</span> }))} />
      <AmountField label="Backing" value={amount} onChange={setAmount} decimals={t.decimals} unit={t.symbol} balanceLabel={unlocked ? "Private balance" : undefined} balance={free} />
      <AmountField label="Largest fill" value={maxSize} onChange={setMaxSize} decimals={18} unit={m.label} help={`Market maximum ${qty(m.maxPairSize)}`} />
      <div className="field">
        <label className="field-label" htmlFor="mk-spread"><span>Open spread, in bps</span></label>
        <input id="mk-spread" className="input-text" inputMode="numeric" value={spread} onChange={(e) => setSpread(e.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="mk-close"><span>Close spread you commit to, in bps</span></label>
        <input id="mk-close" className="input-text" inputMode="numeric" value={closeSpread} onChange={(e) => setCloseSpread(e.target.value)} />
        <div className="field-foot"><span>A taker can close against this spread with no signature from you, for the life of the position.</span></div>
      </div>
      <ExpiryPicker value={expiry} onChange={setExpiry} />
      <Line label="Used as margin per fill">Only the required margin, the rest stays reserved</Line>
      {note ? <p className="notice" role="status">{note}</p> : null}
      <button type="button" className="btn btn-primary btn-block" disabled={!ok} onClick={() => withAccount(go)}>Post backing</button>
    </section>
  );
}

function Body() {
  const view = useView();
  const [managing, setManaging] = useState<string | null>(null);
  if (!view) return <Offline title="Maker desk" />;
  if (view.markets.length === 0) return <StateBlock kind="unavailable" title="No private markets in this deployment" />;
  const locks = view.locks.filter((l) => l.role === "maker" && (l.status === "live" || l.status === "queued" || l.status === "expired"));
  const positions = view.positions.filter((p) => p.side === "maker" && p.status === "open");
  const capacity = locks.filter((l) => l.status === "live").reduce((s, l) => s + l.amount, 0n);
  const asset = view.markets[0]!.collateral;
  return (
    <div className={styles.page}>
      <PageHead title="Maker desk" sub="Back private perps from a private balance. Takers can't see who backs a fill." actions={<SyncBadge />} />
      <ServiceNotice />
      <div className={styles.split}>
        <div className={styles.stack}>
          <section className={styles.card}>
            <div className={styles.between}>
              <h2 className={styles.cardTitle}>Available capacity</h2>
              <PV>{amountText(view, asset, capacity, 2)}</PV>
            </div>
            {!view.unlocked ? <p className={styles.note}>Your backing is private. Open your account to see it.</p> : locks.length === 0 ? <p className={styles.note}>No live backing.</p> : locks.map((l) => <LockRow key={l.id} l={l} view={view} />)}
          </section>
          <section className={styles.stack}>
            {!view.unlocked ? null : positions.length === 0 ? <p className={styles.note}>No positions backed yet.</p> : positions.map((p) => <PositionCard key={p.id} p={p} onOpen={() => setManaging(p.id)} />)}
          </section>
        </div>
        <BackingForm markets={view.markets} />
      </div>
      <PositionDialog id={managing} onClose={() => setManaging(null)} />
    </div>
  );
}

export function PrivateMakers() {
  return <Body />;
}
