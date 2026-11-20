"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import type { Route } from "next";
import { shortAddress } from "@rooq/sdk";
import { BrandMark } from "@/components/public/brand-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAdminNetwork, useAdminRange, type AdminNetwork } from "@/lib/admin/hooks";
import styles from "@/app/admin/admin.module.css";
import { adminHref } from "./admin-href";
import { NetworkSwitch } from "./network-switch";
import { RangePicker } from "./range-picker";
import { SignOutButton } from "./sign-out-button";

interface AdminNavItem {
  readonly href: Route;
  readonly label: string;
}

const NAV: Record<AdminNetwork, readonly AdminNavItem[]> = {
  testnet: [
    { href: "/admin", label: "Overview" },
    { href: "/admin/money", label: "Money" },
    { href: "/admin/activity", label: "Activity" },
    { href: "/admin/wallets", label: "Wallets" },
    { href: "/admin/traffic", label: "Traffic" },
    { href: "/admin/operators", label: "Operators" },
    { href: "/admin/services", label: "Services" },
    { href: "/admin/markets", label: "Markets" },
  ],
  mainnet: [{ href: "/admin", label: "$ROOQ" }],
};

function isCurrent(item: AdminNavItem, path: string): boolean {
  return item.href === "/admin" ? path === "/admin" : path.startsWith(item.href);
}

/** Owner console chrome. Separate from the app shell: no public nav, no wallet bridges, no private account. */
export function AdminShell({ address, children }: { address: `0x${string}`; children: ReactNode }): React.JSX.Element {
  const path = usePathname() ?? "/admin";
  const range = useAdminRange();
  const requested = useAdminNetwork();
  // Only the front page has a mainnet view; every section page is testnet data, whatever the URL says.
  const network: AdminNetwork = path === "/admin" ? requested : "testnet";
  const navRef = useRef<HTMLElement | null>(null);

  // On a phone the section list scrolls sideways; keep the current section in view after navigating.
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
  }, [path]);

  return (
    <div className={styles.shell}>
      <header className={styles.top}>
        <div className={styles.topRow}>
          <Link href={adminHref("/admin", range, network) as Route} className={styles.brand} aria-label="Rooq admin overview">
            <BrandMark variant="micro" />
            <span className={styles.brandName}>Admin</span>
          </Link>
          <div className={styles.network}>
            <NetworkSwitch value={network} />
          </div>
          <div className={styles.topRight}>
            <span className={styles.who} title={address}>
              Signed in as <span className="num">{shortAddress(address)}</span>
            </span>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
        <div className={styles.navRow}>
          <nav ref={navRef} className={styles.nav} aria-label="Admin sections">
            {NAV[network].map((item) => (
              <Link key={item.href} href={adminHref(item.href, range, network) as Route} className={styles.navLink} aria-current={isCurrent(item, path) ? "page" : undefined}>
                {item.label}
              </Link>
            ))}
          </nav>
          <RangePicker />
        </div>
      </header>
      <main id="main" className={styles.main} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
