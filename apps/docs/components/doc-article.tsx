import Link from "next/link";
import type { ReactNode } from "react";
import type { Doc } from "@/lib/content";
import { DOC_PAGES } from "@/lib/manifest";
import { slotParts } from "@/lib/markdown";
import { ContractsTable } from "./contracts-table";
import { DocToc } from "./doc-toc";
import styles from "./docs.module.css";
import { VisibilityLens } from "./visibility-lens";

/** Long pages like the FAQ and glossary list only their main sections. */
const MAX_TOC_ENTRIES = 18;

const SLOTS: Readonly<Record<string, ReactNode>> = {
  lens: <VisibilityLens />,
  "contracts-table": <ContractsTable />,
};

export function DocArticle({ doc, hero, afterContent }: { doc: Doc; hero?: ReactNode; afterContent?: ReactNode }) {
  const index = DOC_PAGES.findIndex((page) => page.slug === doc.slug);
  const previous = index > 0 ? DOC_PAGES[index - 1] : undefined;
  const next = index >= 0 && index < DOC_PAGES.length - 1 ? DOC_PAGES[index + 1] : undefined;
  const toc = doc.headings.length > MAX_TOC_ENTRIES ? doc.headings.filter((h) => h.depth === 2) : doc.headings;

  return (
    <div className={styles.page}>
      <article className={styles.article}>
        {hero ?? (
          <header className={styles.articleHead}>
            <p className={styles.crumb}>{doc.section}</p>
            <h1 className={styles.title}>{doc.title}</h1>
            <p className={styles.lead}>{doc.description}</p>
          </header>
        )}
        {toc.length > 0 ? (
          <details className={styles.mobileToc}>
            <summary>On this page</summary>
            <ul>
              {toc.map((h) => (
                <li className={h.depth === 3 ? styles.tocDeep : undefined} key={h.id}>
                  <a href={`#${h.id}`}>{h.text}</a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {slotParts(doc.html).map((part, i) =>
          part.kind === "html" ? <div className="prose" dangerouslySetInnerHTML={{ __html: part.html }} key={i} /> : <div key={i}>{SLOTS[part.name] ?? null}</div>,
        )}
        {afterContent}
        <p className={styles.markdownLink}>
          <a href={`/${doc.slug}.md`}>View this page as Markdown</a>
        </p>
        {previous || next ? (
          <nav aria-label="More docs" className={styles.pager}>
            {previous ? (
              <Link href={previous.path}>
                <span>Previous</span>
                <strong>{previous.title}</strong>
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link className={styles.pagerNext} href={next.path}>
                <span>Next</span>
                <strong>{next.title}</strong>
              </Link>
            ) : null}
          </nav>
        ) : null}
      </article>
      {toc.length > 0 ? <DocToc headings={toc} /> : null}
    </div>
  );
}
