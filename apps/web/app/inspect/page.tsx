import type { Metadata } from "next";
import { Suspense } from "react";
import { PublicPage } from "@/components/public/public-chrome";
import { InspectView } from "./inspect-view";

export const metadata: Metadata = {
  title: "Inspect a transaction",
  description: "Paste any Robinhood Chain testnet transaction and see exactly what it made public. Then compare a Rooq trade with a normal one.",
  alternates: { canonical: "/inspect" },
};

export default function InspectPage() {
  return (
    <PublicPage>
      <section className="container stack" style={{ paddingTop: 48, paddingBottom: 64, "--gap": "24px" } as React.CSSProperties}>
        <div className="stack" style={{ "--gap": "10px" } as React.CSSProperties}>
          <h1 className="t-page">See what the chain sees</h1>
          <p className="muted" style={{ maxWidth: "64ch" }}>
            Paste any Robinhood Chain testnet transaction. You&apos;ll see what it made public, and for a Rooq transaction, what stayed off the
            chain. Then paste a normal one and compare.
          </p>
        </div>
        <Suspense fallback={null}>
          <InspectView />
        </Suspense>
      </section>
    </PublicPage>
  );
}
