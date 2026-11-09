import Link from "next/link";
import styles from "./docs.module.css";
import { Wordmark } from "./wordmark";
import { APP_URL, SUPPORT_EMAIL } from "@/lib/site";

export function Footer() {
  const year = new Date().getUTCFullYear();
  return (
    <footer className={styles.footer}>
      <p className={styles.footerNotice}>Testnet only. Test tokens have no value. Rooq has not been audited. Leverage can lose your entire margin. Trading privately still has limits.</p>
      <nav aria-label="Footer" className={styles.footerLinks}>
        <a href={APP_URL}>Open Rooq</a>
        <Link href="/risks">Risks</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/privacy-policy">Privacy</Link>
        <a href="/llms.txt">llms.txt</a>
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </nav>
      <div className={styles.footerEnd}>
        <Wordmark className={styles.footerMark} />
        <span>{`© ${year} Rooq. An independent project on Robinhood Chain, not affiliated with Robinhood.`}</span>
      </div>
    </footer>
  );
}
