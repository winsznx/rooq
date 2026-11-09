import type { Metadata } from "next";
import { ArticleShell, PublicPage } from "@/components/public/public-chrome";
import { docsUrl } from "@rooq/config";
import { copy } from "@rooq/ui";

export const metadata: Metadata = { title: "Docs", description: "Rooq documentation: getting started, private balances, spot, perps, liquidity, recovery, risks and contracts.", alternates: { canonical: "/docs" } };

const LINKS: readonly { readonly href: string; readonly title: string; readonly body: string }[] = [
  { href: docsUrl(), title: "Docs home", body: "How Rooq works, from your first deposit to closing a position." },
  { href: docsUrl("getting-started"), title: "Getting started", body: "Connect a wallet, get test funds and create your private account." },
  { href: docsUrl("how-privacy-works"), title: "How privacy works", body: "Exactly what the public, your maker and the risk workers can see." },
  { href: docsUrl("contracts"), title: "Contracts", body: "Every Rooq contract and how to check it yourself." },
];

export default function Docs() {
  return (
    <PublicPage>
      <ArticleShell index={[{ id: "docs", label: "Docs" }, { id: "terms", label: copy.system.terms }, { id: "privacy", label: copy.system.privacy }]} source="Testnet only. Test tokens have no value.">
        <h1 id="docs" className="t-page">{copy.nav.docs}</h1>
        <p>Rooq&apos;s full documentation has its own site.</p>
        <ul>
          {LINKS.map((link) => (
            <li key={link.href}>
              <a href={link.href}>{link.title}</a>. {link.body}
            </li>
          ))}
        </ul>

        <h2 id="terms" className="t-section">{copy.system.terms}</h2>
        <p>
          Rooq is an independent project on Robinhood Chain testnet and isn&apos;t affiliated with Robinhood. Test tokens have no value, the contracts have not been audited and leverage can lose your entire margin. Stock Tokens provide price exposure, not shares. <a href={docsUrl("terms")}>Read the terms</a>.
        </p>

        <h2 id="privacy" className="t-section">{copy.system.privacy}</h2>
        <p>
          Rooq has no accounts on its servers and no analytics. Your private keys stay in your browser. Shields and unshields are public on the chain, and trading privately still has limits. <a href={docsUrl("privacy-policy")}>Read the privacy policy</a>.
        </p>
      </ArticleShell>
    </PublicPage>
  );
}
