"use client";

import { absBig, clearingHouseAbi, formatCountdown, formatFixed, formatLeverageTenths } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import type { MarketSnapshot } from "@/lib/chain-data";
import type { SignedQuote } from "@/lib/quotes";
import { deadlineBase, confirmedLabel, useTxRunner } from "@/lib/tx";
import { useChainNow } from "@/lib/use-now";
import { collateral, fundingPayer, fundingPerHour, percentDistance, price } from "@/lib/display";
import { ActionButton, PriceKindTag, Receipt, ReceiptGroup, ReceiptRow } from "../primitives";
import { Dialog } from "../feedback/dialog";
import { TxProgress } from "../feedback/tx-progress";
import { useToast } from "../feedback/toast";

/** AC06: one unambiguous last review. Required for every perps open, reduce and close in V1. */
export function ReviewTradeDialog({
  open,
  onOpenChange,
  m,
  side,
  signed,
  quote,
  margin,
  fee,
  liq,
  leverageTenths,
  secondsLeft,
  onDone,
  intent = "open",
  realizedEstimate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  m: MarketSnapshot;
  side: "long" | "short";
  signed: bigint;
  quote: SignedQuote;
  margin: bigint;
  fee: bigint;
  liq: bigint | null;
  leverageTenths: number;
  secondsLeft: number | null;
  onDone: () => void;
  intent?: "open" | "reduce" | "close";
  realizedEstimate?: bigint | null;
}) {
  const tx = useTxRunner();
  const toast = useToast();
  const chainNow = useChainNow();
  const left = chainNow === null ? secondsLeft : Number(quote.quote.deadline) - chainNow;
  const deviationBps = m.mark && m.mark > 0n ? (absBig(quote.quote.price - m.mark) * 10_000n) / m.mark : null;
  const outsideBand = m.risk !== null && deviationBps !== null && deviationBps > BigInt(m.risk.maxDeviationBps);
  const statusChanged = intent === "open" ? m.effectivePerpStatus !== "ACTIVE" : m.perpStatus !== "ACTIVE" && m.perpStatus !== "CLOSE_ONLY";
  const stale = (left !== null && left <= 0) || outsideBand || statusChanged;
  const done = tx.steps.length > 0 && tx.steps.every((s) => s.phase === "confirmed");

  const title = intent === "open" ? (side === "long" ? "Review long" : "Review short") : intent === "close" ? copy.perps.close : copy.perps.reduce;

  const confirm = async () => {
    if (!DEPLOYMENT || chainNow === null) return;
    const action = `${intent === "open" ? (side === "long" ? copy.perps.submitLong : copy.perps.submitShort) : intent === "close" ? copy.perps.close : copy.perps.reduce} ${formatFixed(absBig(signed), 18, 4)} ${m.base.symbol}`;
    const receipts = await tx.run([
      {
        label: action,
        address: DEPLOYMENT.clearingHouse,
        abi: clearingHouseAbi,
        functionName: "trade",
        args: [
          quote.quote,
          quote.signature,
          {
            fillSize: signed,
            marginDeposit: margin,
            limitPrice: quote.quote.price,
            maxFeeBps: m.risk?.takerFeeBps ?? 0,
            deadline: BigInt(deadlineBase(chainNow) + 120),
          },
        ],
      },
    ], { kind: "trade", title: action, quoteExpiresAt: Number(quote.quote.deadline) });
    if (receipts) {
      toast.notify({ tone: "success", title: intent === "open" ? "Position opened" : intent === "close" ? "Position closed" : "Position reduced", body: confirmedLabel() });
      onDone();
    }
  };

  const noun = intent === "open" ? (side === "long" ? "Long" : "Short") : intent === "close" ? copy.perps.close : copy.perps.reduce;
  const sizeText = `${formatFixed(absBig(signed), 18, 4)} ${m.base.symbol}`;
  const notional = (absBig(signed) * quote.quote.price) / 10n ** 18n / 10n ** BigInt(18 - m.quote.decimals);
  const labelRow = { "--gap": "6px" } as React.CSSProperties;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) tx.reset();
        onOpenChange(o);
      }}
      title={title}
      dismissible={!tx.busy || tx.leavable}
      footer={
        done ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onOpenChange(false)}>
            Done
          </button>
        ) : stale && !tx.busy ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onOpenChange(false)}>
            Quote changed. Review again
          </button>
        ) : (
          <>
            <p className="t-small muted" style={{ margin: 0 }}>
              {copy.perps.riskWarning}
            </p>
            <ActionButton disabled={tx.busy} state={tx.busy ? "working" : "idle"} onClick={() => void confirm()}>
              {tx.busy ? copy.activity.pending : "Confirm in wallet"}
            </ActionButton>
          </>
        )
      }
    >
      <div className="stack">
        <Receipt
          title={
            <span className="row" style={{ "--gap": "8px" } as React.CSSProperties}>
              <span className="tag" data-tone={side === "long" ? "long" : "short"}>
                {side === "long" ? copy.perps.long : copy.perps.short}
              </span>
              {m.base.symbol}
              <span className="t-small muted" style={{ fontWeight: 400 }}>{`${copy.perps.tab}, isolated${intent === "open" ? `, ${formatLeverageTenths(leverageTenths)}` : ""}`}</span>
            </span>
          }
          status={done ? "Confirmed" : left === null ? null : left <= 0 ? <span className="warn">Quote expired</span> : <span className={left <= 5 ? "warn num" : "num"}>{`Quote valid ${formatCountdown(left)}`}</span>}
        >
          <ReceiptGroup title={done ? "What changed" : "What changes"}>
            <ReceiptRow lead label={`${noun} size`} value={sizeText} sub={collateral(notional, m)} />
            <ReceiptRow label={<span className="row" style={labelRow}>Execution price <PriceKindTag kind="firm" /></span>} value={price(quote.quote.price)} sub={`${percentDistance(m.mark, quote.quote.price)} vs mark`} />
            {intent === "open" ? (
              <ReceiptRow label={copy.perps.margin} value={collateral(margin, m)} />
            ) : (
              <ReceiptRow
                label="Estimated realised PnL"
                value={realizedEstimate === null || realizedEstimate === undefined ? "—" : collateral(realizedEstimate, m, { sign: "always" })}
                tone={realizedEstimate && realizedEstimate < 0n ? "neg" : realizedEstimate && realizedEstimate > 0n ? "pos" : undefined}
              />
            )}
          </ReceiptGroup>
          <ReceiptGroup title={done ? "What it cost" : "What it costs and risks"}>
            <ReceiptRow label={copy.perps.fee} value={collateral(fee, m)} />
            <ReceiptRow label={`${copy.perps.funding} (1h)`} value={fundingPerHour(m.fundingRatePerSecondWad)} sub={fundingPayer(m.fundingRatePerSecondWad)} />
            <ReceiptRow label={<span className="row" style={labelRow}>{copy.perps.liqPrice} <PriceKindTag kind="estimate" /></span>} value={liq ? price(liq) : "—"} sub={liq ? `${percentDistance(m.mark, liq)} from mark` : undefined} />
            <ReceiptRow label={<span className="row" style={labelRow}>{copy.perps.markPrice} <PriceKindTag kind="reference" /></span>} value={price(m.mark)} tone={outsideBand ? "warn" : undefined} />
          </ReceiptGroup>
        </Receipt>
        {outsideBand ? <p className="notice" data-tone="warning">{copy.errors.oracleConflict}</p> : null}
        {statusChanged ? <p className="notice" data-tone="warning">{copy.errors.paused}</p> : null}
        {tx.leavable ? <p className="t-small muted" style={{ margin: 0 }}>You can close this. Operations keeps tracking it.</p> : null}
        <TxProgress steps={tx.steps} />
      </div>
    </Dialog>
  );
}
