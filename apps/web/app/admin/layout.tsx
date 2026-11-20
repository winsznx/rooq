import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminGuest } from "@/components/admin/guest";
import { AdminShell } from "@/components/admin/shell";
import { getAdminSession } from "@/lib/admin/session";

/** Every request re-reads the session cookie; nothing under /admin may be prerendered or cached. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s | Rooq admin" },
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default async function AdminLayout({ children }: { children: ReactNode }): Promise<React.JSX.Element> {
  const session = await getAdminSession();
  if (!session) return <AdminGuest />;
  return <AdminShell address={session.address}>{children}</AdminShell>;
}
