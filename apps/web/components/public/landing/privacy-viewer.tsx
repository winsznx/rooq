"use client";

import { useState } from "react";
import { Eye } from "../../icons";
import styles from "./landing.module.css";

type Viewer = "you" | "anyone" | "maker" | "risk";
type Cell = { state: "show" | "partial" | "hide"; text: string };

const VIEWERS: readonly { id: Viewer; label: string; line: string }[] = [
  { id: "you", label: "You", line: "You see everything about your own account." },
  { id: "anyone", label: "Anyone", line: "Anyone can see what enters and leaves. What happens in between stays private." },
  { id: "maker", label: "The maker", line: "The maker on your trade sees only its own quote, its fill and its side." },
  { id: "risk", label: "Risk service", line: "A risk service sees only what it needs to close a position that fails." },
];

const HIDDEN = "Hidden";

/** Field wording follows the visibility matrix in private V1 addendum section 2.1, in plain words. */
const FIELDS: readonly { label: string; value: string; by: Record<Viewer, Cell> }[] = [
  {
    label: "Market",
    value: "TSLA perps",
    by: { you: { state: "show", text: "TSLA perps" }, anyone: { state: "show", text: "TSLA perps" }, maker: { state: "show", text: "TSLA perps" }, risk: { state: "show", text: "TSLA perps" } },
  },
  {
    label: "Deposit, on the public chain",
    value: "2,000.00 USDG",
    by: { you: { state: "show", text: "2,000.00 USDG" }, anyone: { state: "show", text: "2,000.00 USDG" }, maker: { state: "show", text: "2,000.00 USDG" }, risk: { state: "show", text: "2,000.00 USDG" } },
  },
  {
    label: "Money not in a trade",
    value: "1,820.00 USDG",
    by: { you: { state: "show", text: "1,820.00 USDG" }, anyone: { state: "hide", text: HIDDEN }, maker: { state: "hide", text: HIDDEN }, risk: { state: "hide", text: HIDDEN } },
  },
  {
    label: "Your order and fill",
    value: "Long 0.50 at 374.57",
    by: { you: { state: "show", text: "Long 0.50 at 374.57" }, anyone: { state: "hide", text: HIDDEN }, maker: { state: "partial", text: "Its own fill only" }, risk: { state: "partial", text: "Only what it is assigned" } },
  },
  {
    label: "Open position and margin",
    value: "180.00 USDG margin",
    by: { you: { state: "show", text: "180.00 USDG margin" }, anyone: { state: "hide", text: HIDDEN }, maker: { state: "partial", text: "Its paired side" }, risk: { state: "partial", text: "Enough to close it" } },
  },
];

const LEDGER_HEAD = ["Market", "Side", "Size", "Price", "Margin", "Profit"] as const;
const LEDGER_ROWS: readonly (readonly string[])[] = [
  ["TSLA", "Long", "0.50", "374.57", "90.00", "+4.12"],
  ["AMZN", "Short", "1.20", "221.84", "133.10", "-2.06"],
  ["PLTR", "Long", "4.00", "118.46", "236.92", "+18.40"],
  ["NFLX", "Long", "2.40", "96.12", "115.34", "+7.71"],
  ["AMD", "Short", "0.80", "201.37", "80.55", "-1.34"],
  ["TSLA", "Short", "0.25", "378.10", "47.26", "-3.88"],
  ["PLTR", "Short", "1.50", "117.92", "88.44", "+2.95"],
  ["AMZN", "Long", "0.60", "220.75", "66.22", "+0.64"],
  ["NFLX", "Short", "3.10", "97.40", "150.97", "-6.12"],
];

function LedgerLayer({ layer }: { layer: "sharp" | "soft" }) {
  return (
    <div className={styles.publicLedger} data-layer={layer} aria-hidden>
      {[LEDGER_HEAD, ...LEDGER_ROWS].map((row, r) => (
        <div key={r} data-head={r === 0}>
          {row.map((cell, c) => (
            <span key={c}>{cell}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PrivacyViewer() {
  const [viewer, setViewer] = useState<Viewer>("anyone");
  const current = VIEWERS.find((v) => v.id === viewer)!;
  return (
    <section className={styles.privacy} aria-labelledby="privacy">
      <div className={`${styles.inner} ${styles.privacyGrid}`}>
        <div className={styles.privacyCopy}>
          <h2 id="privacy" className={styles.h2}>
            Your trades are your business
          </h2>
          <p className={styles.lead}>Rooq is a private market. Your balance and positions stay out of public view. Pick who is looking and see exactly what they get.</p>
          <div className={styles.viewers} role="group" aria-label="Who is looking">
            {VIEWERS.map((v) => (
              <button key={v.id} type="button" aria-pressed={viewer === v.id} onClick={() => setViewer(v.id)}>
                {v.label}
              </button>
            ))}
          </div>
          <p className={styles.viewerLine} data-testid="viewer-line" aria-live="polite">
            {current.line}
          </p>
        </div>

        <div className={styles.ledgerStage}>
        <LedgerLayer layer="sharp" />
        <LedgerLayer layer="soft" />
        <div className={styles.ledgerCard} data-testid="privacy-card">
          <p className={styles.ledgerTitle}>
            One position <span>Example</span>
          </p>
          <dl>
            {FIELDS.map((f) => {
              const cell = f.by[viewer];
              return (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd data-state={cell.state}>
                    {cell.state === "hide" ? <span className={styles.dots}>••••••</span> : <span className={styles.cellText}>{cell.text}</span>}
                    {cell.state === "hide" ? <Eye size={15} off aria-hidden /> : null}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className={styles.small}>Deposits and withdrawals are visible on the public chain. Makers see their own quotes and fills. Risk services see what they need to liquidate. Timing, amounts, quotes and market data can still give clues, especially when few people are trading.</p>
        </div>
        </div>
      </div>
    </section>
  );
}
