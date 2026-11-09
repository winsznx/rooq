import type { Metadata } from "next";
import { copy } from "@rooq/ui";
import { PublicPage } from "@/components/public/public-chrome";
import { StatusView } from "./status-view";

export const metadata: Metadata = { title: "System status", description: "Live status of Rooq contracts, price feeds and private services on Robinhood Chain testnet.", alternates: { canonical: "/status" } };

export default function StatusPage() {
  return (
    <PublicPage>
      <section className="container stack" style={{ paddingTop: 48, "--gap": "16px" } as React.CSSProperties}>
        <h1 className="t-page">{copy.system.status}</h1>
        <StatusView />
      </section>
    </PublicPage>
  );
}
