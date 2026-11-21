"use client";

import { useMutation } from "@tanstack/react-query";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { checkReceipts, receiptsIn, type CheckedReceipt } from "@/lib/inspect/receipt-check";
import styles from "./inspect.module.css";

const FAILURE_TEXT: Record<Exclude<CheckedReceipt, { ok: true }>["reason"], string> = {
  MALFORMED: "This isn't a Rooq receipt.",
  OTHER_DEPLOYMENT: "This receipt is for a different Rooq deployment, so it can't be checked here.",
  NO_SUCH_LEAF: "That leaf doesn't exist on chain yet.",
  MISMATCH: "Doesn't match the chain. The token, amount or leaf in this receipt was changed, or it was never real.",
  NOT_CONFIGURED: "Receipt checks aren't available on this build.",
};

export function ReceiptCheckView() {
  const [text, setText] = useState("");
  const check = useMutation({
    mutationFn: async (raw: string) => {
      const receipts = receiptsIn(raw);
      if (!receipts) return null;
      return checkReceipts(receipts);
    },
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    check.mutate(text);
  }

  async function load(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const raw = await file.text();
    setText(raw);
    check.mutate(raw);
  }

  return (
    <section className="stack" style={{ "--gap": "16px" } as React.CSSProperties} aria-labelledby="receipt-check">
      <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
        <h2 id="receipt-check" className="t-section">Check a receipt</h2>
        <p className="muted" style={{ maxWidth: "64ch" }}>
          Someone sent you a Rooq receipt? Check it against the chain. You&apos;ll see the token, amount and leaf of each private note in it, and
          nothing about the sender&apos;s address or other activity.
        </p>
      </div>
      <form className="stack" style={{ "--gap": "12px" } as React.CSSProperties} onSubmit={submit}>
        <label className="field">
          <span className="field-label">Receipt file</span>
          <input type="file" accept="application/json,.json" onChange={(e) => void load(e)} />
        </label>
        <label className="field">
          <span className="field-label">Or paste it</span>
          <span className="input-wrap">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck={false} style={{ width: "100%", resize: "vertical" }} placeholder='{ "receipts": [ … ] }' />
          </span>
        </label>
        <div>
          <button type="submit" className="btn btn-primary" disabled={text.trim() === "" || check.isPending}>{check.isPending ? "Checking…" : "Check receipt"}</button>
        </div>
      </form>
      {check.error ? <p className="notice" data-tone="negative">Couldn&apos;t reach Robinhood Chain testnet. Try again in a moment.</p> : null}
      {check.data === null ? <p className="notice" data-tone="negative">{FAILURE_TEXT.MALFORMED}</p> : null}
      {check.data ? (
        <ul className="stack" style={{ "--gap": "12px", listStyle: "none", padding: 0, margin: 0 } as React.CSSProperties} data-testid="receipt-results">
          {check.data.map((r, i) =>
            r.ok ? (
              <li key={i} className={styles.private}>
                <h3 style={{ margin: 0 }}>On chain: <span className="num">{r.amount}</span></h3>
                <p className={styles.note}>
                  {r.origin === "deposit" ? "A deposit into Rooq" : "A private note"} at leaf <span className="num">{r.leafIndex}</span> of the Rooq pool. The
                  amount matches what the contract stored.
                </p>
              </li>
            ) : (
              <li key={i} className={styles.public}>
                <h3 style={{ margin: 0 }}>Not confirmed{r.leafIndex !== null ? ` (leaf ${r.leafIndex})` : ""}</h3>
                <p className={styles.note}>{FAILURE_TEXT[r.reason]}</p>
              </li>
            ),
          )}
        </ul>
      ) : null}
      <p className="muted t-small">
        A receipt proves a note with this token and amount was created on Rooq. It doesn&apos;t prove who holds it now or that it hasn&apos;t been spent.
        The check runs in your browser against the public chain.
      </p>
    </section>
  );
}
