"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { docsUrl } from "@rooq/config";
import { ChevronDown, ChevronRight } from "../../icons";
import { PublicFooter } from "../public-chrome";
import styles from "./landing.module.css";

const CHECKS: readonly { title: string; body: string; href: string }[] = [
  { title: "Read every contract", body: "Addresses and what each one does.", href: "/docs" },
  { title: "See what is running", body: "Live status of the chain, prices and quotes.", href: "/status" },
  { title: "See every market", body: "Prices, limits and who backs them.", href: "/app/markets" },
  { title: "Read the risks", body: "How losing money works, in plain words.", href: "/learn" },
  { title: "Use the API", body: "The same data the app uses.", href: "/developers" },
  { title: "How it works", body: "Spot, perps and fees, step by step.", href: "/how-it-works" },
];

const FAQ: readonly { q: string; a: string }[] = [
  { q: "Is this real money?", a: "No. Rooq runs on testnet, so tokens have no real value. You can try everything for free." },
  { q: "Are my trades private?", a: "Yes. Your balances, positions and fills aren't published. Deposits and withdrawals are visible on the public chain, and timing can give clues." },
  { q: "Who can see my trades?", a: "You see everything. The maker on your trade sees its own quote and fill. A risk service sees what it needs to liquidate a failing position." },
  { q: "Has Rooq been audited?", a: "No. Rooq has not been audited, so don't treat it as safe for real money." },
  { q: "What can I lose?", a: "With leverage, you can lose everything you put into that trade. Buying the token has no leverage and can't be closed out, but its price can still fall." },
  { q: "Do I get a share of the company?", a: "No. A stock token is a token that follows a price. It is not share ownership." },
];

/** Verify, ask, start, and the footer: the end of the page in one white block. */
export function CheckIt() {
  const [open, setOpen] = useState(0);
  return (
    <section className={styles.white} aria-labelledby="check">
      <div className={styles.inner}>
        <h2 id="check" className={`${styles.h2} ${styles.centerHead}`}>
          Check it yourself
        </h2>
        <div className={styles.checkGrid}>
          <nav className={styles.verify} aria-label="Things you can verify">
            {CHECKS.map((c) => (
              <Link key={c.href} href={c.href as Route}>
                <span>
                  <strong>{c.title}</strong>
                  <small>{c.body}</small>
                </span>
                <ChevronRight size={18} />
              </Link>
            ))}
          </nav>
          <div className={styles.faq}>
            {FAQ.map((f, i) => (
              <div key={f.q}>
                <h3>
                  <button type="button" aria-expanded={open === i} aria-controls={`faq-${i}`} onClick={() => setOpen(open === i ? -1 : i)}>
                    {f.q}
                    <ChevronDown size={18} style={{ transform: open === i ? "rotate(180deg)" : undefined }} />
                  </button>
                </h3>
                <p id={`faq-${i}`} hidden={open !== i}>
                  {f.a}
                </p>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.finalCta}>
          <div className={styles.finalCopy}>
            <h2>Try it with test money</h2>
            <p>Connect a wallet, sign once and place your first private trade. It takes about a minute.</p>
          </div>
          <div className={styles.finalActions}>
            <Link href="/app/markets" className={styles.finalButton}>
              Start trading
              <span className={styles.finalButtonIcon} aria-hidden="true"><ChevronRight /></span>
            </Link>
            <a href={docsUrl("getting-started")} className={styles.finalButton}>
              Get test funds
              <span className={styles.finalButtonIcon} aria-hidden="true"><ChevronRight /></span>
            </a>
          </div>
        </div>
      </div>
      <PublicFooter surface="light" />
    </section>
  );
}
