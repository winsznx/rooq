import type { Metadata } from "next";
import Link from "next/link";
import { docsUrl } from "@rooq/config";
import { copy } from "@rooq/ui";
import { ArticleShell, PublicPage } from "@/components/public/public-chrome";

export const metadata: Metadata = { title: "How it works", description: "How Rooq keeps balances and positions private with encrypted notes and zero-knowledge proofs on Robinhood Chain.", alternates: { canonical: "/how-it-works" } };

export default function HowItWorks() {
  return (
    <PublicPage>
      <ArticleShell index={[{ id: "pick-a-market", label: "Pick a market" }, { id: "choose-spot-or-perps", label: "Choose spot or perps" }, { id: "review-the-numbers", label: "Review the numbers" }, { id: "prove-and-lock", label: "Prove and lock" }, { id: "a-2x-example", label: "A 2x example" }, { id: "fees-and-risk-terms", label: "Fees and risk terms" }, { id: "what-others-can-see", label: "What others can see" }]} source="Testnet only. Test tokens have no value.">
        <h1 className="t-page">How Rooq works</h1>
        <p>Every Rooq market lets you do one of two different things with the same asset. You can own it, or you can take a position on its price. Both are private by default, and the page shows each one side by side so you can see which one you are doing before you confirm.</p>

        <h2 id="pick-a-market" className="t-section">1. Pick a market</h2>
        <p>A market is one token paired with a quote asset. Its page shows the token&apos;s full contract address, where its price comes from and whether each mode is open right now.</p>

        <h2 id="choose-spot-or-perps" className="t-section">2. Choose spot or perps</h2>
        <p>
          <strong>Spot</strong> swaps tokens in a private Rooq pool. You hold the token in your private balance. Nothing can be liquidated.
        </p>
        <p>
          <strong>Perps</strong> open a position on the token&apos;s price using margin. You don&apos;t receive the token. Your margin is locked privately, a maker&apos;s standing offer takes the other side, and the contract checks that both of you have enough margin before anything settles.
        </p>

        <h2 id="review-the-numbers" className="t-section">3. Review the numbers</h2>
        <p>Before you confirm, Rooq shows the worst price you accept, the fee, the margin you post and the time you are willing to wait. Funding is a separate, continuous payment between long and short positions.</p>

        <h2 id="prove-and-lock" className="t-section">4. Prove and lock</h2>
        <p>Your browser makes a proof that your trade follows the rules, without showing the trade. A relayer submits it, so your public wallet isn&apos;t involved. The operation center tracks every step. If nothing fills by your expiry, your funds come back. Shields and unshields use your connected wallet and are public.</p>

        <h2 id="a-2x-example" className="t-section">A 2x example</h2>
        <p>Example only. With 1,000 USDG of margin at 2x leverage you hold a 2,000 USDG position. If the price moves 10% in your favour, the position gains about 200 USDG, 20% of your margin, before fees and funding. If it moves 10% against you, you lose about the same. If losses take your margin below the maintenance requirement, the position can be liquidated and a penalty applies.</p>

        <h2 id="fees-and-risk-terms" className="t-section">Fees and risk terms</h2>
        <dl className="facts">
          <div>
            <dt>Pool fee</dt>
            <dd className="text">Charged on spot swaps and kept in the pool for liquidity providers.</dd>
          </div>
          <div>
            <dt>Trading fee</dt>
            <dd className="text">Charged on perps fills, shown before you confirm.</dd>
          </div>
          <div>
            <dt>Funding</dt>
            <dd className="text">Paid between the two sides of a position based on long and short balance.</dd>
          </div>
          <div>
            <dt>Liquidation</dt>
            <dd className="text">Closing a position whose margin is below maintenance, at the oracle mark.</dd>
          </div>
        </dl>
        <p style={{ marginTop: 32 }}>
          <Link href="/app/markets" className="btn btn-primary">
            {copy.landing.ctaSecondary}
          </Link>
        </p>

        <h2 id="what-others-can-see" className="t-section">What others can see</h2>
        <p>
          Your balances, positions and profit or loss are not published. Shields and unshields stay public, makers see their own fills, and two risk workers can read what they need for liquidation. Trading privately still has limits. <a href={docsUrl("how-privacy-works")}>See what each party can see</a>.
        </p>
      </ArticleShell>
    </PublicPage>
  );
}
