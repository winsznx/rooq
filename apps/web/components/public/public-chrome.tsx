import Link from "next/link";
import type { ReactNode } from "react";
import { SUPPORT_EMAIL, X_HANDLE, X_URL } from "@rooq/config";
import { copy } from "@rooq/ui";
import { PublicNav } from "./public-nav";
import styles from "./public.module.css";
import { BrandMark } from "./brand-mark";

/** `surface` pins the logo colours when the footer sits on a light block inside a dark page. */
export function PublicFooter({ surface }: { surface?: "light" } = {}) {
  return (
    <footer className={styles.footer}>
      <div className={styles.frame}>
        <div className={styles.disclosure}>
          <p>Testnet only. Test tokens have no value. Rooq is not audited. Leverage can lose your entire margin. Deposits and withdrawals are visible on the public chain, and timing can give clues.</p>
          <p className={styles.runsOn}>{copy.system.independent}</p>
        </div>
        <div className={styles.footerGrid}>
          <div className={styles.footerBrand}>
            <Link href="/" className={styles.wordmark} aria-label="Rooq home">
              <BrandMark variant="wordmark" surface={surface} />
            </Link>
            <p>Buy stock tokens or trade their price with leverage. Your balances and positions stay out of public view.</p>
            <a href={X_URL} className={styles.social} target="_blank" rel="noreferrer me">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
              <span>Follow {X_HANDLE}</span>
            </a>
            <a href={`mailto:${SUPPORT_EMAIL}`} className={styles.social}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M3 6h18v12H3zM3 7l9 6 9-6" /></svg>
              <span>{SUPPORT_EMAIL}</span>
            </a>
          </div>
          <nav aria-label="Product">
            <h2>Product</h2>
            <Link href="/app/markets">{copy.nav.markets}</Link>
            <Link href="/app/trade">{copy.nav.trade}</Link>
            <Link href="/app/swap">{copy.nav.swap}</Link>
            <Link href="/app/liquidity">{copy.nav.liquidity}</Link>
          </nav>
          <nav aria-label="Learn">
            <h2>Learn</h2>
            <Link href="/how-it-works">How it works</Link>
            <Link href="/learn">{copy.system.riskLink}</Link>
            <Link href="/docs">{copy.nav.docs}</Link>
            <Link href="/developers">Developers</Link>
          </nav>
          <nav aria-label="More">
            <h2>More</h2>
            <Link href="/app/makers">{copy.nav.makers}</Link>
            <Link href="/app/create">{copy.nav.create}</Link>
            <Link href="/status">{copy.system.status}</Link>
            <Link href="/docs#terms">{copy.system.terms}</Link>
            <Link href="/docs#privacy">{copy.system.privacy}</Link>
          </nav>
        </div>
      </div>
      <div className={styles.ghost} aria-hidden="true">
        <BrandMark variant="wordmark" surface={surface} className={styles.ghostMark} />
      </div>
    </footer>
  );
}

export function PublicPage({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  return (
    <>
      <PublicNav />
      <main id="main" tabIndex={-1} className={flush ? undefined : styles.main}>
        {children}
      </main>
      <PublicFooter />
    </>
  );
}

/** Long-form page layout. `index` is the page's own section list; the source line says what it describes. */
export function ArticleShell({ index, source, children }: { index: readonly { id: string; label: string }[]; source: string; children: ReactNode }) {
  return (
    <div className="container article">
      <nav className="article-index" aria-label="On this page">
        <ul role="list">
          {index.map((i) => (
            <li key={i.id}>
              <a href={`#${i.id}`}>{i.label}</a>
            </li>
          ))}
        </ul>
      </nav>
      <article className="prose">
        {children}
        <p className="article-source">{source}</p>
      </article>
    </div>
  );
}
