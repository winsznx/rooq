import type { Metadata } from "next";
import { docsUrl } from "@rooq/config";
import { ArticleShell, PublicPage } from "@/components/public/public-chrome";
import { KnowledgeCheck } from "./knowledge-check";

export const metadata: Metadata = { title: "Learn", description: "Learn how private stock token markets work on Rooq: spot, perpetuals, margin, funding, liquidation and what stays private.", alternates: { canonical: "/learn" } };

export default function Learn() {
  return (
    <PublicPage>
      <ArticleShell index={[{ id: "swap", label: "Swapping" }, { id: "collateral", label: "Collateral and margin" }, { id: "leverage", label: "Leverage" }, { id: "funding", label: "Funding" }, { id: "liquidation", label: "Liquidation" }]} source="Testnet only. Test tokens have no value.">
        <h1 className="t-page">Spot, margin and leverage</h1>
        <p>
          Short guides to the terms you will see on Rooq. None of this is financial advice. Test tokens have no value. The <a href={docsUrl("risks")}>risks page</a> has the full list of what can go wrong.
        </p>

        <h2 id="swap" className="t-section">Swapping</h2>
        <p>A swap trades one token for another against a private Rooq pool. The pool prices each trade from its reserves, so larger trades move the price more. Reserves are private, so the quote you see is a rounded estimate. You set a minimum. If the operator can&apos;t fill your swap at that minimum by your expiry, your tokens come back.</p>
        <KnowledgeCheck question="After a spot buy, what do you hold?" options={["The token, in my private balance", "A position that can be liquidated"]} answer={0} explanation="Spot settles the token itself. There is no margin and no liquidation." />

        <h2 id="collateral" className="t-section">Collateral and margin</h2>
        <p>Perps use your private balance as collateral. Margin you assign to a position is locked in that position alone. Only your free balance can be sent or unshielded, and the contracts enforce that.</p>
        <KnowledgeCheck question="Can you unshield margin that backs an open position?" options={["Yes, any time", "No, only balance that is not in a position"]} answer={1} explanation="Margin stays in the position until you reduce it, remove it or close." />

        <h2 id="leverage" className="t-section">Leverage</h2>
        <p>Leverage is position size divided by margin. Each market has a maximum set at deployment. Higher leverage means less margin for the same size and a liquidation price closer to the current price.</p>

        <h2 id="funding" className="t-section">Funding</h2>
        <p>Funding moves between the two sides of each position. When more traders are long than short, longs pay. When more are short, shorts pay. Funding never creates or destroys collateral. It only moves between the two sides.</p>
        <KnowledgeCheck question="When most open positions are long, who pays funding?" options={["Longs pay shorts", "Shorts pay longs"]} answer={0} explanation="Rooq's funding rate follows the long and short balance and is capped per hour." />

        <h2 id="liquidation" className="t-section">Liquidation</h2>
        <p>If losses take a position&apos;s equity below its maintenance margin at a fresh oracle price, one of two risk workers can liquidate it, even while you are offline. The position closes at the oracle mark and a capped penalty is charged. The liquidation price on screen is an estimate. Funding, fees and price gaps can move it. If the oracle stops updating, new positions and liquidations wait for a fresh price.</p>
        <KnowledgeCheck question="Is the displayed liquidation price guaranteed?" options={["Yes", "No, it is an estimate"]} answer={1} explanation="It can move as funding and fees accrue, and prices can gap past it." />
      </ArticleShell>
    </PublicPage>
  );
}
