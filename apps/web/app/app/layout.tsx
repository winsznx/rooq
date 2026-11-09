import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";

/** The app's CSP uses a per-request nonce, which a prerendered page can't carry. */
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
