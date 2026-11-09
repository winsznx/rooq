"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { DOC_SECTIONS, docPath } from "@/lib/manifest";
import { APP_URL } from "@/lib/site";
import styles from "./docs.module.css";
import { DocsSearch } from "./docs-search";
import { ReadingRule } from "./reading-rule";
import { ThemeToggle } from "./theme-toggle";
import { Wordmark } from "./wordmark";

type Drawer = { readonly path: string; readonly focus: "search" | "menu" };

function NavSections({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <>
      {DOC_SECTIONS.map((section) => (
        <div className={styles.navSection} key={section.title}>
          <p>{section.title}</p>
          <ul>
            {section.pages.map((page) => {
              const href = docPath(page.slug);
              return (
                <li key={page.slug}>
                  <Link aria-current={pathname === href ? "page" : undefined} href={href} onClick={onNavigate}>
                    {page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20">
      <path d={d} stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" />
    </svg>
  );
}

const SEARCH_ICON = "M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Zm9.5 2.5-4.2-4.2";
const MENU_ICON = "M4 7h16M4 12h16M4 17h16";
const CLOSE_ICON = "M6 6l12 12M18 6 6 18";

/** Header, sidebar and the mobile drawer. The drawer belongs to the page it was opened on, so navigating closes it. */
export function DocsChrome({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const open = drawer?.path === pathname ? drawer : null;
  const close = () => setDrawer(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.brand}>
            <Link aria-label="Rooq docs home" href="/">
              <Wordmark className={styles.logo} />
            </Link>
            <span className={styles.docsLabel}>Docs</span>
          </div>
          <div className={styles.headerSearch}>
            <DocsSearch />
          </div>
          <nav aria-label="Site" className={styles.headerLinks}>
            <Link href="/risks">Risks</Link>
            <a className={styles.cta} href={APP_URL}>
              Open Rooq
            </a>
          </nav>
          <button aria-label="Search the docs" className={styles.iconButton} onClick={() => setDrawer({ path: pathname, focus: "search" })} type="button">
            <Icon d={SEARCH_ICON} />
          </button>
          <button aria-expanded={Boolean(open)} aria-label="Open the docs menu" className={styles.iconButton} onClick={() => setDrawer({ path: pathname, focus: "menu" })} type="button">
            <Icon d={MENU_ICON} />
          </button>
        </div>
        <ReadingRule />
      </header>
      <div className={styles.frame}>
        <nav aria-label="Docs" className={styles.sidebar}>
          <NavSections pathname={pathname} />
          <ThemeToggle />
        </nav>
        <main className={styles.main} id="main" tabIndex={-1}>
          {children}
          {footer}
        </main>
      </div>
      {open ? (
        <div className={styles.drawerLayer}>
          <button aria-label="Close the docs menu" className={styles.backdrop} onClick={close} tabIndex={-1} type="button" />
          <div aria-label="Docs menu" aria-modal="true" className={styles.drawer} role="dialog">
            <div className={styles.drawerHead}>
              <Link aria-label="Rooq docs home" href="/" onClick={close}>
                <Wordmark className={styles.logo} />
              </Link>
              <button aria-label="Close the docs menu" autoFocus={open.focus === "menu"} className={`${styles.iconButton} ${styles.drawerClose}`} onClick={close} type="button">
                <Icon d={CLOSE_ICON} />
              </button>
            </div>
            <div className={styles.drawerSearch}>
              <DocsSearch autoFocus={open.focus === "search"} onNavigate={close} shortcut={false} />
            </div>
            <nav aria-label="Docs" className={styles.drawerNav}>
              <NavSections onNavigate={close} pathname={pathname} />
            </nav>
            <div className={styles.drawerFoot}>
              <ThemeToggle />
              <a className={styles.cta} href={APP_URL}>
                Open Rooq
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
