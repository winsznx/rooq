"use client";

import { useState } from "react";
import { formatFixed, parseDecimal } from "@rooq/sdk";
import { Dialog } from "@/components/feedback/dialog";
import { AmountField } from "@/components/funds/amount-field";
import { Tabs } from "@/components/primitives";
import { wallet } from "@/lib/private/client";
import { fundingAccrued, liquidationPrice, pnl } from "@/lib/private/math";
import type { ClaimView, MarketView, PositionView, PrivateView } from "@/lib/private/types";
import { amountText, balanceOf, countdown, Line, MarketIcon, PV, px, qty, Stat, styles, TokenIcon, tokenOf, useView } from "./kit";

const WAD = 10n ** 18n;

type Panel = "margin" | "reduce" | "close" | "funding" | "exit";

function marketOf(view: PrivateView, p: PositionView): MarketView | null {
  return view.markets.find((m) => m.id === p.market) ?? null;
}

function myMargin(p: PositionView): bigint {
  return p.side === "taker" ? p.takerMargin : p.makerMargin;
}

function sideWord(p: PositionView): string {
  const long = p.side === "taker" ? !p.isShort : p.isShort;
  return long ? "Long" : "Short";
}

export function PositionCard({ p, onOpen }: { p: PositionView; onOpen: () => void }) {
  const view = useView();
  if (!view) return null;
  const m = marketOf(view, p);
  const token = tokenOf(view, p.asset);
  const pnlValue = m?.mark ? pnl(p.side === "taker" ? p.isShort : !p.isShort, p.size, p.entry, m.mark, m.scale) : null;
  const acc = m ? fundingAccrued(p.isShort, p.size, p.fundingIndex, m.fundingIndex, m.scale) : 0n;
  const fundingCost = p.side === "taker" ? acc : -acc;
  const liq = m && p.status === "open" ? liquidationPrice(p.side === "taker" ? p.isShort : !p.isShort, p.size, p.entry, myMargin(p), m.mmrWad, m.scale) : null;
  return (
    <div className={styles.card} data-testid="position-card" data-status={p.status}>
      <div className={styles.cardHead}>
        <span className={styles.row}>
          <MarketIcon market={p.market} />
          <strong>{`${sideWord(p)} ${m?.label ?? p.market.toString()}`}</strong>
          {p.side === "maker" ? <span className={styles.badge}>You back this</span> : null}
          {p.exitMatureAt !== null ? <span className={styles.badge} data-tone="warn">Forced exit</span> : null}
          {p.status !== "open" ? <span className={styles.badge} data-tone={p.status === "liquidated" ? "bad" : undefined}>{p.status}</span> : null}
        </span>
        {p.status === "open" ? <button type="button" className="btn btn-sm" onClick={onOpen}>Manage</button> : null}
      </div>
      <div className={styles.posGrid}>
        <Stat label="Size"><PV>{qty(p.size)}</PV></Stat>
        <Stat label="Entry">{<PV>{px(p.entry)}</PV>}</Stat>
        <Stat label="Mark">{m?.mark ? px(m.mark) : "Stale"}</Stat>
        <Stat label="Your margin"><PV>{amountText(view, p.asset, myMargin(p), 2)}</PV></Stat>
        <Stat label="PnL"><PV>{pnlValue === null ? "Unavailable" : `${pnlValue > 0n ? "+" : ""}${formatFixed(pnlValue, token.decimals, 2)} ${token.symbol}`}</PV></Stat>
        {liq !== null ? <Stat label="Liquidation, est."><PV>{liq.toFixed(2)}</PV></Stat> : null}
      </div>
      {p.status === "open" && fundingCost !== 0n ? <p className={styles.note}><PV>{`${fundingCost > 0n ? "Owed" : "Earned"}: ${formatFixed(fundingCost < 0n ? -fundingCost : fundingCost, token.decimals, 4)} ${token.symbol}`}</PV> funding since the last settlement.</p> : null}
      {p.exitMatureAt !== null && view.chainNow !== null && p.status === "open" ? <p className={styles.note}>{p.exitMatureAt > view.chainNow ? `Closes in ${countdown(p.exitMatureAt - view.chainNow)}. Liquidation still applies during the wait.` : "This exit has matured. A risk worker closes it at the next fresh price."}</p> : null}
      {p.outcome ? <p className={styles.note}>Paid out <PV>{amountText(view, p.asset, p.outcome.payout ?? 0n)}</PV>{p.outcome.mark !== null ? ` at mark ${px(p.outcome.mark)}` : ""}.</p> : null}
    </div>
  );
}

function FundingTable({ p, view }: { p: PositionView; view: PrivateView }) {
  if (p.funding.length === 0) return <p className={styles.note}>No funding has settled on this position yet.</p>;
  return (
    <div>
      {p.funding.map((f) => (
        <div key={f.version} className={styles.rowLine}>
          <span>{`Settlement ${f.version}, ${f.takerPays ? "taker paid" : "maker paid"}`}</span>
          <span className={styles.rowValue}>
            <PV>{`owed ${amountText(view, p.asset, f.owed)} / paid ${amountText(view, p.asset, f.paid)}`}</PV>
            {f.shortfall > 0n ? <span className={styles.badge} data-tone="warn"> shortfall <PV>{amountText(view, p.asset, f.shortfall)}</PV></span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

export function PositionDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const view = useView();
  const [panel, setPanel] = useState<Panel>("margin");
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [reduce, setReduce] = useState("");
  const [confirmExit, setConfirmExit] = useState(false);
  const p = view?.positions.find((x) => x.id === id) ?? null;
  if (!view || !p) return null;
  const m = marketOf(view, p);
  const token = tokenOf(view, p.asset);
  const title = `${sideWord(p)} ${m?.label ?? p.market.toString()}`;
  const parsed = parseDecimal(amount, token.decimals);
  const reduceWad = parseDecimal(reduce, 18);
  const isTaker = p.side === "taker";
  const start = (t: Parameters<typeof wallet.start>[0], label: string) => {
    void wallet.start(t, label, "/app/portfolio");
    onClose();
  };
  const tabs: { value: Panel; label: string }[] = [
    { value: "margin", label: "Margin" },
    ...(isTaker ? [{ value: "reduce" as Panel, label: "Reduce" }, { value: "close" as Panel, label: "Close" }] : []),
    { value: "funding", label: "Funding" },
    { value: "exit", label: "Forced exit" },
  ];
  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && onClose()} title={title} description="Every change here is a new private version of this position. Keys and proofs stay on this device." width={520}>
      <div className={styles.stack}>
        <Tabs group="pos" label="Manage position" value={panel} onChange={setPanel} tabs={tabs} block />
        {panel === "margin" ? (
          <div className={styles.stack}>
            <Tabs group="mm" label="Add or remove" value={mode} onChange={setMode} tabs={[{ value: "add", label: "Add" }, { value: "remove", label: "Remove" }]} />
            <AmountField label={mode === "add" ? "Add margin" : "Remove margin"} value={amount} onChange={setAmount} decimals={token.decimals} unit={token.symbol} balanceLabel={mode === "add" ? "Private balance" : "Your margin"} balance={mode === "add" ? balanceOf(view, p.asset) : myMargin(p)} />
            <p className={styles.note}>{mode === "remove" ? "You must stay above initial margin at a fresh price, counting gains only up to what your counterparty has posted." : "Added from your private balance, using one note."}</p>
            <button type="button" className="btn btn-primary btn-block" disabled={parsed === null || parsed <= 0n} onClick={() => parsed !== null && start({ t: "update", position: p.id, add: mode === "add" ? parsed : 0n, remove: mode === "remove" ? parsed : 0n, reduce: 0n }, `${mode === "add" ? "Add" : "Remove"} margin on ${title}`)}>
              {mode === "add" ? "Add margin" : "Remove margin"}
            </button>
          </div>
        ) : null}
        {panel === "reduce" ? (
          <div className={styles.stack}>
            <AmountField label="Reduce size" value={reduce} onChange={setReduce} decimals={18} unit={m?.label ?? ""} balanceLabel="Position size" balance={p.size} />
            <p className={styles.note}>Settles at mark less the spread your maker committed to at open.</p>
            <button type="button" className="btn btn-primary btn-block" disabled={reduceWad === null || reduceWad <= 0n || reduceWad >= p.size} onClick={() => reduceWad !== null && start({ t: "update", position: p.id, add: 0n, remove: 0n, reduce: reduceWad }, `Reduce ${title}`)}>Reduce position</button>
          </div>
        ) : null}
        {panel === "close" ? (
          <div className={styles.stack}>
            <Line label="Fills at">{m?.mark ? <PV>{px(m.mark)}</PV> : "Price is stale"}</Line>
            <Line label="Committed close spread">{`${Number(p.closeSpreadBps) / 100}%`}</Line>
            <p className={styles.note}>You close alone, at any time, with no maker signature. A fresh price is required.</p>
            <button type="button" className="btn btn-primary btn-block" disabled={!m?.mark} onClick={() => start({ t: "close", position: p.id }, `Close ${title}`)}>Close position</button>
          </div>
        ) : null}
        {panel === "funding" ? <FundingTable p={p} view={view} /> : null}
        {panel === "exit" ? (
          <div className={styles.stack}>
            {p.exitMatureAt !== null && view.chainNow !== null ? (
              <p className="notice" role="status">{p.exitMatureAt > view.chainNow ? `Forced exit requested. Matures in ${countdown(p.exitMatureAt - view.chainNow)}.` : "This exit has matured. A risk worker closes it at the next fresh price, with no spread and no penalty."}</p>
            ) : (
              <>
                <p className={styles.note}>{`Closes this position after 7 days at the mark, with no spread and no penalty. Use this if the other side has gone. A refundable ${formatFixed(view.exitBond, 18, 3)} ETH bond is posted by the relayer. Liquidation still applies during the wait.`}</p>
                {!confirmExit ? (
                  <button type="button" className="btn btn-block" onClick={() => setConfirmExit(true)}>Request forced exit</button>
                ) : (
                  <button type="button" className="btn btn-danger btn-block" onClick={() => start({ t: "exit", position: p.id }, `Forced exit on ${title}`)}>Confirm: start the 7-day exit</button>
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

export function ClaimRow({ c }: { c: ClaimView }) {
  const view = useView();
  if (!view) return null;
  const paid = c.ratio !== null ? (c.amount * c.ratio) / WAD : null;
  return (
    <div className={styles.rowLine}>
      <span className={styles.row}><TokenIcon view={view} asset={c.asset} />{`Shortfall claim, market ${c.market}`}</span>
      <span className={styles.row}>
        <PV>{amountText(view, c.asset, c.amount)}</PV>
        {c.status === "waiting" ? <span className={styles.badge}>Waiting for the next funding epoch</span> : null}
        {c.status === "redeemable" ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void wallet.start({ t: "redeem", claim: c.id }, "Redeem claim", "/app/portfolio")}>
            {`Redeem ${paid !== null ? amountText(view, c.asset, paid, 2) : ""}`}
          </button>
        ) : null}
      </span>
    </div>
  );
}
