"use client";

import Link from "next/link";
import { useState } from "react";
import { Eye } from "../../icons";
import { EyeToggle, Masked } from "./masked";
import styles from "./landing.module.css";

const STEPS = [
  { title: "Deposit", body: "Move USDG into your private balance. The deposit itself shows on the public chain. On testnet, the faucet gives you some for free.", rows: [["Deposited", "+500.00 USDG"]] },
  { title: "Pick a market", body: "Choose a stock token. Buy it, or trade its price. Private either way.", rows: [["Market", "TSLA, 2x long"]] },
  { title: "See your price", body: "You get one exact price and what it costs, good for a few seconds. Nothing is hidden.", rows: [["Your price", "374.57"], ["Fee", "0.11 USDG"]] },
  { title: "Trade", body: "Confirm in your wallet. Your trade settles without being published. You can leave the page while it finishes.", rows: [["Position", "0.50 TSLA"], ["Money put up", "90.00 USDG"]] },
  { title: "Get a receipt", body: "Close when you want. The receipt shows what changed, what it cost and what settled, and it is yours to keep or share.", rows: [["Closed at", "382.81"], ["Profit", "+4.12 USDG"]] },
] as const;

/** For each stop, the fields an outside observer gets. `null` means hidden. Follows addendum section 2.1. */
const PUBLIC_VIEW: readonly (readonly (readonly [string, string | null])[])[] = [
  [["Deposit of USDG", "500.00"], ["Your private balance", null]],
  [["Market you chose", null], ["Your private balance", null]],
  [["Your price", null], ["Your fee", null]],
  [["Your position", null], ["Your margin", null]],
  [["Your profit", null], ["Your receipt", null]],
];

/** The same fields as your own account shows them. */
const YOUR_VIEW: readonly (readonly (readonly [string, string])[])[] = [
  [["Deposit of USDG", "500.00"], ["Your private balance", "500.00 USDG"]],
  [["Market you chose", "TSLA, 2x long"], ["Your private balance", "500.00 USDG"]],
  [["Your price", "374.57"], ["Your fee", "0.11 USDG"]],
  [["Your position", "0.50 TSLA"], ["Your margin", "90.00 USDG"]],
  [["Your profit", "+4.12 USDG"], ["Your receipt", "Saved"]],
];

/** Five clickable stops. The receipt grows by one block at each stop. */
export function Journey() {
  const [step, setStep] = useState(0);
  const [hidden, setHidden] = useState(false);
  const current = STEPS[step]!;
  const last = STEPS.length - 1;
  return (
    <section className={styles.white} aria-labelledby="how-title" id="how">
      <div className={styles.inner}>
        <div className={styles.ownHead}>
        <h2 id="how-title" className={styles.h2}>
          From deposit to receipt
        </h2>
        <p className={styles.lead}>Each step stays between you and the people on your trade.</p>
        </div>
        <ol className={styles.journey} aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.title} data-state={i < step ? "done" : i === step ? "now" : "next"}>
              <button type="button" aria-current={i === step ? "step" : undefined} onClick={() => setStep(i)}>
                <span className={styles.stepDot}>{i + 1}</span>
                {s.title}
              </button>
            </li>
          ))}
        </ol>
        <div className={styles.journeyBody}>
          <div className={styles.journeyText}>
            <h3 className={styles.h3} data-testid="journey-title">
              {current.title}
            </h3>
            <p className={styles.lead}>{current.body}</p>
            <div className={styles.journeyViews}>
            <div className={styles.journeyYou} data-testid="journey-you">
              <p>What you see</p>
              {YOUR_VIEW[step]!.map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <b>{value}</b>
                </div>
              ))}
            </div>
            <div className={styles.journeyPublic} data-testid="journey-public">
              <p>What others see</p>
              {PUBLIC_VIEW[step]!.map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <b data-hidden={value === null}>{value ?? "••••••"}</b>
                  {value === null ? <Eye size={15} off /> : <span />}
                </div>
              ))}
            </div>
            </div>
            <div className={styles.journeyNav}>
              <button type="button" className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>
                Back
              </button>
              {step === last ? (
                <Link href="/app/markets" className="btn btn-primary">
                  Try it with test money
                </Link>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)}>
                  Next
                </button>
              )}
            </div>
          </div>
          <div className={styles.receipt} data-testid="journey-receipt">
            <p className={styles.receiptHead}>
              Your private receipt
              <span className={styles.receiptTools}>
                Example
                <EyeToggle hidden={hidden} onToggle={() => setHidden((h) => !h)} label="receipt values" />
              </span>
            </p>
            {STEPS.flatMap((s, i) =>
              s.rows.map(([label, value]) => (
                <div key={label} className={styles.receiptLine} data-done={i <= step}>
                  <span>{label}</span>
                  <span>{i <= step ? <Masked hidden={hidden}>{value}</Masked> : "Waiting"}</span>
                </div>
              )),
            )}
            <p className={styles.receiptFoot}>{step === last ? "Done. Saved to your activity." : `${last - step} step${last - step === 1 ? "" : "s"} to go`}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
