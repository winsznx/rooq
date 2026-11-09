import type { ReactNode } from "react";

/** Route changes fade the content only; the shell and its operation dock stay in place. */
export default function AppTemplate({ children }: { children: ReactNode }) {
  return <div className="page-in">{children}</div>;
}
