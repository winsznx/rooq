"use client";

import Link from "next/link";
import { useState } from "react";
import { copy } from "@rooq/ui";
import { ThemeToggle } from "../theme-toggle";
import { Close, Menu } from "../icons";
import { BrandMark } from "./brand-mark";
import styles from "./public.module.css";

const LINKS = [
  { href: "/app/markets", label: copy.nav.markets },
  { href: "/app/trade", label: copy.nav.trade },
  { href: "/how-it-works", label: "How it works" },
  { href: "/developers", label: "For builders" },
  { href: "/docs", label: copy.nav.docs },
] as const;

/** The floating bar: always a solid frosted surface, so it never prints over the page. */
export function PublicNav({ themed = true }: { themed?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <header className={styles.navWrap}>
      <div className={styles.nav}>
        <Link href="/" className={styles.wordmark} aria-label="Rooq home">
          <BrandMark variant="horizontal" className={styles.logoWide} />
          <BrandMark variant="wordmark" className={styles.logoCompact} />
        </Link>
        <nav className={styles.navLinks} aria-label="Site">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className={styles.navRight}>
          {themed ? <ThemeToggle /> : null}
          <Link href="/app" className={`btn btn-sm ${styles.launch}`}>
            Launch app
          </Link>
          <button type="button" className={styles.menu} aria-expanded={open} aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((o) => !o)}>
            {open ? <Close size={22} /> : <Menu size={22} />}
          </button>
        </div>
        {open ? (
          <nav className={styles.sheet} aria-label="Site, mobile">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)}>
                {l.label}
              </Link>
            ))}
            <Link href="/app" className="btn btn-primary btn-block" onClick={() => setOpen(false)}>
              Launch app
            </Link>
          </nav>
        ) : null}
      </div>
    </header>
  );
}
