"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { price } from "@/lib/display";
import { usePrivate } from "@/lib/private/client";
import { listedMarkets } from "@/lib/private/market-list";
import { Dialog } from "../feedback/dialog";
import { AssetEmblem, PerpStatusPill } from "../primitives";
import { Search } from "../icons";

/** Cmd-K switcher (teardown rule 27): filters by symbol or name as you type. */
export function MarketSwitcher({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { view } = usePrivate();
  const [q, setQ] = useState("");
  const path = usePathname() ?? "";
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = view ? listedMarkets(view) : [];
    return needle ? list.filter((m) => m.symbol.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)) : list;
  }, [view, q]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Find a market" width={560}>
      <label className="input-wrap" style={{ marginBottom: 12 }}>
        <Search size={18} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Symbol or name" aria-label="Search markets" style={{ fontFamily: "var(--rq-font-ui-stack)", fontSize: 15 }} />
      </label>
      <ul className="switcher-list" role="list">
        {results.map((m) => (
          <li key={m.key}>
            <Link href={`/app/trade/${m.key}?mode=${m.market ? "perps" : "spot"}`} className="switcher-row" aria-current={path === `/app/trade/${m.key}` ? "true" : undefined} onClick={() => onOpenChange(false)}>
              <AssetEmblem logoUrl={m.logoUrl} assetClass={m.assetClass} size={24} label={m.symbol} />
              <span className="switcher-name">
                <strong>{m.symbol}</strong>
                <span className="t-small muted">{m.name}</span>
              </span>
              <span className="num">{price(m.market?.mark ?? null)}</span>
              {m.market ? <PerpStatusPill status="ACTIVE" fresh={m.market.markFresh} /> : <span className="tag">Spot only</span>}
            </Link>
          </li>
        ))}
        {results.length === 0 ? <li className="empty">No market found for this search.</li> : null}
      </ul>
      <p className="t-small faint" style={{ margin: "12px 0 0" }}>Enter opens a market. Esc closes. ⌘K opens this from anywhere in the app.</p>
    </Dialog>
  );
}
