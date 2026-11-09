import type { Metadata } from "next";
import Link from "next/link";
import { DocArticle } from "@/components/doc-article";
import styles from "@/components/docs.module.css";
import { getDoc } from "@/lib/content";
import { DOC_SECTIONS, INTRODUCTION_SLUG, docPath } from "@/lib/manifest";

export const metadata: Metadata = { title: { absolute: "Rooq Docs" }, alternates: { canonical: "/" } };

const READ_FIRST = [
  { slug: "introduction", title: "Know what Rooq is", blurb: "Spot or perps, and why your trades stay private.", href: "#what-rooq-does" },
  { slug: "how-privacy-works", title: "See what others can see", blurb: "Pick an observer and read Rooq from where they stand." },
  { slug: "risks", title: "Read the risks", blurb: "What you can lose, and the limits of privacy." },
  { slug: "getting-started", title: "Set up and trade", blurb: "Test funds, and a private account from one signature." },
];

export default function HomePage() {
  const doc = getDoc(INTRODUCTION_SLUG);
  if (!doc) throw new Error("The introduction page is missing from the manifest.");

  return (
    <DocArticle
      afterContent={
        <section aria-labelledby="index-title" className={styles.index}>
          <h2 id="index-title">All docs</h2>
          <div className={styles.indexGrid}>
            {DOC_SECTIONS.map((section) => (
              <div key={section.title}>
                <h3>{section.title}</h3>
                <ul>
                  {section.pages.map((page) => (
                    <li key={page.slug}>
                      <Link href={docPath(page.slug)}>{page.title}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      }
      doc={doc}
      hero={
        <header className={styles.hero}>
          <h1 className={styles.heroTitle}>Understand the trade before you make it.</h1>
          <p className={styles.lead}>Rooq is private spot and perps for stock tokens on Robinhood Chain testnet. These docs explain how it works, what stays hidden and what you can lose.</p>
          <ol className={styles.path}>
            {READ_FIRST.map((item) => (
              <li key={item.slug}>
                <Link href={item.href ?? docPath(item.slug)}>
                  <strong>{item.title}</strong>
                  <span>{item.blurb}</span>
                </Link>
              </li>
            ))}
          </ol>
        </header>
      }
    />
  );
}
