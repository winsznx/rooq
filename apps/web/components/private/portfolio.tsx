"use client";

import Link from "next/link";
import { useState } from "react";
import type { Hex } from "viem";
import { StateBlock, Tabs, tabId, tabPanelId } from "@/components/primitives";
import { useWalletOperations } from "@/components/ops/operation-center";
import { isActive } from "@/lib/operations";
import { RememberCard } from "./account";
import { BalancesPanel, ShieldDialog, TransferDialog, UnshieldDialog } from "./funds";
import { IconRow, Offline, PageHead, PrivateUnavailable, PV, qty, ServiceNotice, styles, SyncBadge, useView, withAccount } from "./kit";
import { ClaimRow, PositionCard, PositionDialog } from "./positions";
import { LockRow } from "./trade";

function FundsDialogs({ shield, unshield, transfer, setShield, setUnshield, setTransfer, unshieldAsset }: { shield: boolean; unshield: boolean; transfer: boolean; setShield: (o: boolean) => void; setUnshield: (o: boolean) => void; setTransfer: (o: boolean) => void; unshieldAsset?: Hex }) {
  return (
    <>
      <ShieldDialog open={shield} onOpenChange={setShield} />
      <UnshieldDialog key={String(unshieldAsset)} open={unshield} onOpenChange={setUnshield} initial={unshieldAsset} />
      <TransferDialog open={transfer} onOpenChange={setTransfer} />
    </>
  );
}

function useFunds() {
  const [shield, setShield] = useState(false);
  const [unshield, setUnshield] = useState(false);
  const [unshieldAsset, setUnshieldAsset] = useState<Hex | undefined>(undefined);
  const [transfer, setTransfer] = useState(false);
  return {
    open: { shield, unshield, transfer, setShield, setUnshield, setTransfer, unshieldAsset },
    actions: {
      onShield: () => withAccount(() => setShield(true)),
      onUnshield: (a?: Hex) =>
        withAccount(() => {
          setUnshieldAsset(a);
          setUnshield(true);
        }),
      onTransfer: () => withAccount(() => setTransfer(true)),
    },
  };
}

type Tab = "open" | "pending" | "liquidity" | "closed";

function PortfolioBody() {
  const view = useView();
  const funds = useFunds();
  const [tab, setTab] = useState<Tab>("open");
  const [managing, setManaging] = useState<string | null>(null);
  if (!view) return <Offline title="Portfolio" />;
  const open = view.positions.filter((p) => p.status === "open");
  const closed = view.positions.filter((p) => p.status !== "open");
  const pending = view.locks.filter((l) => l.status === "live" || l.status === "queued" || l.status === "expired");
  const claims = view.claims.filter((c) => c.status === "waiting" || c.status === "redeemable");
  return (
    <div className={styles.page}>
      <PageHead title="Portfolio" sub="Private balances and positions, decrypted on this device from chain data." actions={<SyncBadge />} />
      <ServiceNotice />
      <BalancesPanel {...funds.actions} />
      <RememberCard />
      {claims.length > 0 ? (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Claims</h2>
          {claims.map((c) => <ClaimRow key={c.id} c={c} />)}
        </section>
      ) : null}
      <Tabs group="pf" label="Sections" value={tab} onChange={setTab} tabs={[{ value: "open", label: `Positions (${open.length})` }, { value: "pending", label: `Locks (${pending.length})` }, { value: "liquidity", label: `Liquidity (${view.lp.length})` }, { value: "closed", label: `History (${closed.length})` }]} />
      <div role="tabpanel" id={tabPanelId("pf", tab)} aria-labelledby={tabId("pf", tab)} className={styles.stack}>
        {!view.unlocked ? <p className={styles.note}>Your positions, locks and liquidity are private. Open your account to see them here.</p> : null}
        {tab === "open" && view.unlocked ? (open.length === 0 ? <StateBlock kind="empty" title="No open positions" actions={<Link className="btn btn-sm" href="/app/trade">Trade</Link>} /> : open.map((p) => <PositionCard key={p.id} p={p} onOpen={() => setManaging(p.id)} />)) : null}
        {tab === "pending" && view.unlocked ? (pending.length === 0 ? <StateBlock kind="empty" title="No locks waiting" /> : <section className={styles.card}>{pending.map((l) => <LockRow key={l.id} l={l} view={view} />)}</section>) : null}
        {tab === "liquidity" && view.unlocked ? (view.lp.length === 0 ? <StateBlock kind="empty" title="No liquidity" actions={<Link className="btn btn-sm" href="/app/liquidity">Add liquidity</Link>} /> : <section className={styles.card}>{view.lp.map((l) => <div key={l.id} className={styles.rowLine}><span className={styles.row}><IconRow view={view} icons={(() => { const p = view.pools.find((x) => x.id === l.pool); return p ? [{ asset: p.token0 }, { asset: p.token1 }] : []; })()} />{`Pool ${l.pool}`}</span><PV>{qty(l.shares, 6)}</PV></div>)}</section>) : null}
        {tab === "closed" && view.unlocked ? (closed.length === 0 ? <StateBlock kind="empty" title="Nothing closed yet" /> : closed.map((p) => <PositionCard key={p.id} p={p} onOpen={() => undefined} />)) : null}
      </div>
      <PositionDialog id={managing} onClose={() => setManaging(null)} />
      <FundsDialogs {...funds.open} />
    </div>
  );
}

export function PrivatePortfolio() {
  return <PortfolioBody />;
}

/** Private blocks on the Overview. Masked until an account opens; the page around them is public. */
export function OverviewPrivate() {
  const view = useView();
  const funds = useFunds();
  const [managing, setManaging] = useState<string | null>(null);
  const ops = useWalletOperations();
  if (!view) return <PrivateUnavailable />;
  const openPositions = view.positions.filter((p) => p.status === "open");
  const expired = view.locks.filter((l) => l.status === "expired");
  const redeemable = view.claims.filter((c) => c.status === "redeemable");
  const stuck = ops.filter((o) => o.privateActions && !isActive(o) && (o.stage === "failed" || o.stage === "recovery_required"));
  return (
    <div className={styles.stack}>
      <ServiceNotice />
      <BalancesPanel {...funds.actions} />
      <RememberCard />
      {openPositions.map((p) => <PositionCard key={p.id} p={p} onOpen={() => setManaging(p.id)} />)}
      {view.unlocked && (expired.length > 0 || redeemable.length > 0 || stuck.length > 0) ? (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Needs attention</h2>
          {expired.map((l) => <LockRow key={l.id} l={l} view={view} />)}
          {redeemable.map((c) => <ClaimRow key={c.id} c={c} />)}
          {stuck.map((o) => <div key={o.id} className={styles.rowLine}><span>{o.title}</span><span className={styles.rowValue}>{o.message}</span></div>)}
        </section>
      ) : null}
      {view.unlocked && view.activity.length > 0 ? (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Recent</h2>
          {view.activity.slice(0, 5).map((a) => <div key={a.id} className={styles.rowLine}><span className={styles.row}><IconRow view={view} icons={a.icons} /><PV plain>{a.title}</PV></span></div>)}
          <Link href="/app/activity" className="btn btn-sm">All activity</Link>
        </section>
      ) : null}
      <PositionDialog id={managing} onClose={() => setManaging(null)} />
      <FundsDialogs {...funds.open} />
    </div>
  );
}
