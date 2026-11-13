"use client";

import { useState } from "react";
import { formatFixed, parseDecimal, toDecimalInput } from "@rooq/sdk";
import { Dialog } from "@/components/feedback/dialog";
import { AmountField } from "@/components/funds/amount-field";
import { usePrivate, wallet } from "@/lib/private/client";
import type { LpView, PoolView, PrivateView } from "@/lib/private/types";
import { balanceOf, ExpiryPicker, Offline, PageHead, PV, ServiceNotice, styles, SyncBadge, TokenPair, tokenOf, useView, withAccount } from "./kit";
import { fetchQuote, poolName } from "./spot";
import { LockRow } from "./trade";

function AddForm({ pool, view }: { pool: PoolView; view: PrivateView }) {
  const { status } = usePrivate();
  const unlocked = status === "unlocked";
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [expiry, setExpiry] = useState(3_600n);
  const [t0, t1] = [tokenOf(view, pool.token0), tokenOf(view, pool.token1)];
  const a0 = parseDecimal(a, t0.decimals);
  const a1 = parseDecimal(b, t1.decimals);
  const overBalance = unlocked && ((a0 !== null && a0 > balanceOf(view, pool.token0)) || (a1 !== null && a1 > balanceOf(view, pool.token1)));
  const fill = async () => {
    if (a0 === null || a0 <= 0n) return;
    try {
      const q = await fetchQuote(pool.id, 0n, pool.token0, a0);
      setB(toDecimalInput(q.amountOut, t1.decimals));
    } catch (error) {
      setNote(error instanceof Error ? error.message : "No quote right now.");
    }
  };
  const go = () => {
    if (a0 === null || a1 === null) return;
    void wallet.start({ t: "lpAdd", pool: pool.id, amount0: a0, amount1: a1, minShares: 1n, expiry }, `Add liquidity to ${poolName(view, pool)}`, "/app/liquidity").then(() => {
      setNote("Started. Two private locks, then the pool takes them. Any excess comes back to you.");
      setA("");
      setB("");
    });
  };
  return (
    <section className={`${styles.card} ${styles.lpCard}`} aria-label={`Add to ${poolName(view, pool)}`}>
      <div className={styles.cardHead}>
        <span className={styles.row}><TokenPair view={view} token0={pool.token0} token1={pool.token1} /><h2 className={styles.cardTitle}>{poolName(view, pool)}</h2></span>
        <span className={styles.badge} data-tone={pool.seeded ? "ok" : "warn"}>{pool.seeded ? `${Number(pool.feeBps) / 100}% fee` : "Needs a first deposit"}</span>
      </div>
      <AmountField label={t0.symbol} value={a} onChange={setA} decimals={t0.decimals} unit={t0.symbol} balanceLabel={unlocked ? "Private balance" : undefined} balance={balanceOf(view, pool.token0)} />
      <AmountField label={t1.symbol} value={b} onChange={setB} decimals={t1.decimals} unit={t1.symbol} balanceLabel={unlocked ? "Private balance" : undefined} balance={balanceOf(view, pool.token1)} />
      <div className={styles.row}>
        {pool.seeded ? <button type="button" className="btn btn-sm" onClick={() => void fill()}>Match pool ratio</button> : null}
        <ExpiryPicker value={expiry} onChange={setExpiry} />
      </div>
      <p className={styles.note}>{pool.seeded ? "Reserves are private, so this uses a rounded price. The pool takes its exact ratio and refunds the rest." : "You set the first price for this pool."}</p>
      {overBalance ? <p className="notice" role="status">This is more than your private balance.</p> : note ? <p className="notice" role="status">{note}</p> : null}
      <button type="button" className={`btn btn-primary btn-block ${styles.lpSubmit}`} disabled={a0 === null || a0 <= 0n || a1 === null || a1 <= 0n || overBalance} onClick={() => withAccount(go)}>Add liquidity</button>
    </section>
  );
}

function PositionRow({ lp, view, onRemove }: { lp: LpView; view: PrivateView; onRemove: () => void }) {
  const pool = view.pools.find((p) => p.id === lp.pool);
  return (
    <div className={styles.rowLine} data-testid="lp-row" data-status={lp.status}>
      <span className={styles.row}>{pool ? <TokenPair view={view} token0={pool.token0} token1={pool.token1} /> : null}{pool ? poolName(view, pool) : `Pool ${lp.pool}`}</span>
      <span className={styles.row}>
        <PV>{`${formatFixed(lp.shares, 18, 6)} shares`}</PV>
        {lp.status === "idle" ? <button type="button" className="btn btn-sm" onClick={onRemove}>Remove</button> : null}
        {lp.status === "removing" ? <span className={styles.badge}>Removal requested</span> : null}
        {lp.status === "request_expired" ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void wallet.start({ t: "lpRecover", claim: lp.id }, "Return liquidity to idle", "/app/liquidity")}>Return to idle</button>
        ) : null}
      </span>
    </div>
  );
}

function RemoveDialog({ lp, view, onClose }: { lp: LpView | null; view: PrivateView; onClose: () => void }) {
  const [min0, setMin0] = useState("");
  const [min1, setMin1] = useState("");
  const [expiry, setExpiry] = useState(3_600n);
  const pool = lp ? view.pools.find((p) => p.id === lp.pool) : undefined;
  if (!lp || !pool) return null;
  const [t0, t1] = [tokenOf(view, pool.token0), tokenOf(view, pool.token1)];
  const m0 = min0 === "" ? 1n : parseDecimal(min0, t0.decimals);
  const m1 = min1 === "" ? 1n : parseDecimal(min1, t1.decimals);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Remove from ${poolName(view, pool)}`} description="A private request the operator fills. If it's ignored past expiry, your shares return to idle." width={460}>
      <div className={styles.stack}>
        <AmountField label={`Minimum ${t0.symbol}`} value={min0} onChange={setMin0} decimals={t0.decimals} unit={t0.symbol} />
        <AmountField label={`Minimum ${t1.symbol}`} value={min1} onChange={setMin1} decimals={t1.decimals} unit={t1.symbol} />
        <p className={styles.note}>Reserves are private, so Rooq can&apos;t compute these for you. Left blank, you accept any amount the pool pays.</p>
        <ExpiryPicker value={expiry} onChange={setExpiry} />
        <button type="button" className="btn btn-primary btn-block" disabled={m0 === null || m1 === null} onClick={() => { if (m0 === null || m1 === null) return; void wallet.start({ t: "lpRequest", claim: lp.id, min0: m0, min1: m1, expiry }, `Remove liquidity from ${poolName(view, pool)}`, "/app/liquidity"); onClose(); }}>Request removal</button>
      </div>
    </Dialog>
  );
}

function Body() {
  const view = useView();
  const [removing, setRemoving] = useState<LpView | null>(null);
  if (!view) return <Offline title="Private liquidity" />;
  const locks = view.locks.filter((l) => l.role === "lp" && (l.status === "live" || l.status === "queued" || l.status === "expired"));
  return (
    <div className={styles.page}>
      <PageHead title="Private liquidity" sub="Deposit into a pool privately. Pool reserves and your share stay hidden." actions={<SyncBadge />} />
      <ServiceNotice />
      <div className={styles.split}>
        <div className={styles.grid2}>
          {view.pools.map((p) => <AddForm key={p.id.toString()} pool={p} view={view} />)}
        </div>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Your positions</h2>
          {!view.unlocked ? <p className={styles.note}>Your positions are private. Open your account to see them.</p> : view.lp.length === 0 && locks.length === 0 ? <p className={styles.note}>No liquidity yet.</p> : null}
          {view.lp.map((lp) => <PositionRow key={lp.id} lp={lp} view={view} onRemove={() => setRemoving(lp)} />)}
          {locks.map((l) => <LockRow key={l.id} l={l} view={view} />)}
        </section>
      </div>
      <RemoveDialog key={removing?.id ?? "none"} lp={removing} view={view} onClose={() => setRemoving(null)} />
    </div>
  );
}

export function PrivateLiquidity() {
  return <Body />;
}

