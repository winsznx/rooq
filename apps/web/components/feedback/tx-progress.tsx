"use client";

import { AnimatePresence, motion } from "motion/react";
import { copy, copyAt } from "@rooq/ui";
import { shortAddress } from "@rooq/sdk";
import { confirmedLabel, settlementNote, type TxStep } from "@/lib/tx";
import { txUrl } from "@/lib/env";
import { Blocked, Check, External, Warning } from "../icons";

const PHASE_TEXT: Record<TxStep["phase"], string> = {
  idle: "Not started",
  simulating: "Checking with the contract",
  wallet: copy.activity.pending,
  submitted: copy.activity.submitted,
  unconfirmed: copyAt("activity.unconfirmed"),
  confirmed: confirmedLabel(),
  reverted: copy.activity.failed,
  rejected: copy.errors.signatureRejected,
  failed: copy.activity.failed,
};

/** AC07. True transaction state per step; a sequencer receipt is never shown as Ethereum finality. */
export function TxProgress({ steps }: { steps: readonly TxStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="tx-steps" aria-live="polite">
      {steps.map((s, i) => {
        const url = s.hash ? txUrl(s.hash) : null;
        return (
          <li key={`${s.label}-${i}`} className="tx-step" data-phase={s.phase}>
            <span className="tx-icon" aria-hidden>
              {s.phase === "confirmed" ? <Check size={16} /> : s.phase === "failed" || s.phase === "reverted" || s.phase === "unconfirmed" ? <Warning size={16} /> : s.phase === "rejected" ? <Blocked size={16} /> : <span className="tx-dot" />}
            </span>
            <div className="tx-text">
              <strong>{s.label}</strong>
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={s.phase} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  {s.error?.message ?? PHASE_TEXT[s.phase]}
                </motion.span>
              </AnimatePresence>
              {s.phase === "confirmed" ? <span className="faint">{`Block ${s.blockNumber?.toString() ?? "—"}. ${settlementNote()}`}</span> : null}
              {s.hash ? (
                url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="row" style={{ "--gap": "4px" } as React.CSSProperties}>
                    <span className="num">{shortAddress(s.hash)}</span> {copy.activity.view} <External size={14} />
                  </a>
                ) : (
                  <span className="num faint" title={s.hash}>{`Tx ${shortAddress(s.hash)}`}</span>
                )
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
