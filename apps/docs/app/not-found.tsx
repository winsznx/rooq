import Link from "next/link";
import styles from "@/components/docs.module.css";

export default function NotFound() {
  return (
    <div className={styles.page}>
      <article className={styles.article}>
        <header className={styles.articleHead}>
          <h1 className={styles.title}>This page doesn&apos;t exist</h1>
          <p className={styles.lead}>It may have moved. Search above, or go back to the start of the docs.</p>
        </header>
        <p>
          <Link className={styles.cta} href="/">
            Back to docs home
          </Link>
        </p>
      </article>
    </div>
  );
}
