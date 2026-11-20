"use client";

import { notFound, usePathname } from "next/navigation";
import styles from "@/app/admin/admin.module.css";
import { AdminSignIn } from "./sign-in";

/**
 * What a visitor without a session sees. Only the bare /admin path offers sign-in; every other admin path is
 * indistinguishable from a page that doesn't exist.
 */
export function AdminGuest(): React.JSX.Element {
  const path = usePathname();
  if (path !== "/admin") notFound();
  return (
    <main id="main" className={styles.gate} tabIndex={-1}>
      <AdminSignIn />
    </main>
  );
}
