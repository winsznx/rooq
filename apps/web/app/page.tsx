import type { Metadata } from "next";
import { X_URL } from "@rooq/config";
import Link from "next/link";
import Image from "next/image";
import { PublicNav } from "@/components/public/public-nav";
import { HeroDemo } from "@/components/public/landing/hero-demo";
import { OwnOrTrade } from "@/components/public/landing/own-or-trade";
import { PrivacyViewer } from "@/components/public/landing/privacy-viewer";
import { Journey } from "@/components/public/landing/journey";
import { Earn } from "@/components/public/landing/earn";
import { CheckIt } from "@/components/public/landing/check-it";
import { TokenLogo } from "@/components/public/landing/token-logo";
import { TokenCa } from "@/components/public/landing/token-ca";
import styles from "@/components/public/landing/landing.module.css";

const TOKENS = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD", "USDG"] as const;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3200";

export const metadata: Metadata = { alternates: { canonical: "/" } };

const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", "@id": `${SITE_URL}/#org`, name: "Rooq", url: SITE_URL, sameAs: [X_URL], logo: `${SITE_URL}/brand/logos/symbol-black.svg` },
    { "@type": "WebSite", "@id": `${SITE_URL}/#site`, name: "Rooq", url: SITE_URL, publisher: { "@id": `${SITE_URL}/#org` } },
    {
      "@type": "WebApplication",
      name: "Rooq",
      url: `${SITE_URL}/app/markets`,
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      description: "A private market for stock tokens on Robinhood Chain testnet. Buy tokenized stocks on spot or trade their price with leverage on perpetuals, while balances, positions and trades stay out of public view.",
      publisher: { "@id": `${SITE_URL}/#org` },
    },
  ],
};

export default function Landing() {
  return (
    <div className={styles.landing} data-theme="dark">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD).replace(/</g, "\\u003c") }} />
      <PublicNav themed={false} />
      <main id="main" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <Image src="/art/glow.webp" alt="" fill priority sizes="100vw" className={styles.heroGlow} />
          <div className={styles.heroCopy}>
            <h1 id="hero-title" className={styles.h1}>
              Private markets
              <br /> for stock tokens
            </h1>
            <p className={styles.sub}>Buy the token or trade its price with leverage, while your balances and positions stay out of public view.</p>
            <Link href="/app/markets" className={`btn btn-primary ${styles.heroCta}`}>
              Start trading
            </Link>
            <TokenCa />
          </div>
          <div className={styles.heroStage}>
            <HeroDemo />
          </div>
          <div className={styles.tokenRow}>
            <p>Stock tokens and USDG on testnet</p>
            <ul role="list">
              {TOKENS.map((s) => (
                <li key={s}>
                  <TokenLogo symbol={s} size={30} />
                  {s}
                </li>
              ))}
            </ul>
          </div>
        </section>
        <OwnOrTrade />
        <PrivacyViewer />
        <Journey />
        <Earn />
        <CheckIt />
      </main>
    </div>
  );
}
