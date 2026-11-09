"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { copy } from "@rooq/ui";
import { useAccountSnapshot, useMarketSnapshots } from "@/lib/chain-data";
import { SpotTicket } from "@/components/trade/spot-ticket";
import { Address, AssetEmblem, StateBlock } from "@/components/primitives";
import { AssetSelector } from "@/components/funds/asset-selector";

/** S01. One focused card (max 480px). Routes only through Rooq pools; no external route is implied. */
export function SwapView({ initial }: { initial: string | null }) {
  const { data: markets, isLoading } = useMarketSnapshots();
  const { address } = useAccount();
  const { data: acct } = useAccountSnapshot(address);
  const funded = (markets ?? []).filter((m) => m.reserveBase > 0n);
  const [key, setKey] = useState<string | null>(initial);
  const m = funded.find((x) => x.deployed.key === key) ?? funded[0];

  return (
    <div style={{ padding: "24px var(--rq-gutter) 48px", display: "grid", justifyItems: "center" }}>
      <div className="stack" style={{ width: "100%", maxWidth: 480, "--gap": "16px" } as React.CSSProperties}>
        <h1 className="t-section">{copy.nav.swap}</h1>
        {isLoading ? <StateBlock kind="loading" title="Reading pools from the chain" /> : null}
        {!isLoading && !m ? <StateBlock kind="empty" title={copy.spot.emptyPool} /> : null}
        {m ? (
          <>
            <AssetSelector markets={funded} value={m} onChange={(x) => setKey(x.deployed.key)} />
            <div>
              <SpotTicket m={m} acct={acct} />
            </div>
            <div className="row" style={{ "--gap": "10px" } as React.CSSProperties}>
              <AssetEmblem logoUrl={m.base.logoUrl} assetClass={m.base.assetClass} size={24} label={m.base.symbol} />
              <span className="t-small">
                <strong>{m.base.name}</strong>
                <span className="muted">{m.base.verified ? " Verified token" : m.base.isTestFixture ? " Test fixture, no value" : " Unverified token"}</span>
                {m.base.assetClass === "stock-token" ? <span className="muted"> Token. Not share ownership.</span> : null}
              </span>
              <Address value={m.base.address} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
