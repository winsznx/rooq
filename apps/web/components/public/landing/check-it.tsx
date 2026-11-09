"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { copy } from "@rooq/ui";
import { ChevronDown, ChevronRight } from "../../icons";
import { BrandMark } from "../brand-mark";
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
          <p>Try it with test money. It takes a minute.</p>
          <Link href="/app/markets" className="btn btn-primary btn-lg">
            Start trading
          </Link>
        </div>
      </div>
      <footer className={styles.footer}>
        <div className={styles.footerRow}>
          <Link href="/" className={styles.footerMark} aria-label="Rooq home">
            <BrandMark variant="wordmark" surface="light" />
          </Link>
          <nav aria-label="Footer">
            <Link href="/app/markets">{copy.nav.markets}</Link>
            <Link href="/app/trade">{copy.nav.trade}</Link>
            <Link href="/app/makers">{copy.nav.makers}</Link>
            <Link href="/docs">{copy.nav.docs}</Link>
            <Link href="/status">{copy.system.status}</Link>
            <Link href="/docs#terms">{copy.system.terms}</Link>
            <Link href="/docs#privacy">{copy.system.privacy}</Link>
          </nav>
        </div>
        <p className={styles.small}>Testnet only. Test tokens have no value. Not audited. Leverage can lose your entire margin. Deposits and withdrawals are visible on the public chain, and timing can give clues. {copy.system.independent}</p>
      </footer>
    </section>
  );
}
