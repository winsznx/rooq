"use client";

import { useMemo, useState } from "react";
import type { MarketSnapshot } from "@/lib/chain-data";
import { price } from "@/lib/display";
import { Dialog } from "../feedback/dialog";
import { AssetEmblem, Address, TestTag } from "../primitives";
import { ChevronDown, Search } from "../icons";
import styles from "./asset-selector.module.css";

/** AC08. Searchable by symbol, name or exact address. Identity is the chain address, not the ticker. */
export function AssetSelector({ markets, value, onChange, label = "Token" }: { markets: readonly MarketSnapshot[]; value: MarketSnapshot; onChange: (m: MarketSnapshot) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? markets.filter((m) => m.base.symbol.toLowerCase().includes(needle) || m.base.name.toLowerCase().includes(needle) || m.base.address.toLowerCase() === needle) : markets;
  }, [markets, q]);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <button type="button" className={styles.trigger} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <AssetEmblem logoUrl={value.base.logoUrl} assetClass={value.base.assetClass} size={32} label={value.base.symbol} />
        <span className={styles.name}>
          <strong>{value.base.symbol}</strong>
          <span>{value.base.name}</span>
        </span>
        <ChevronDown size={16} />
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="Choose a token" width={520}>
        <label className="input-wrap" style={{ marginBottom: 8 }}>
          <Search size={18} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Symbol, name or contract address" aria-label="Search tokens" style={{ fontFamily: "var(--rq-font-ui-stack)", fontSize: 15 }} />
        </label>
        <ul className={styles.list} role="list">
          {rows.map((m) => (
            <li key={m.marketId} className={styles.row}>
              <button
                type="button"
                className={styles.option}
                aria-current={m.marketId === value.marketId ? "true" : undefined}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                  setQ("");
                }}
              >
                <AssetEmblem logoUrl={m.base.logoUrl} assetClass={m.base.assetClass} size={24} label={m.base.symbol} />
                <span className={styles.name}>
                  <strong>
                    {m.base.symbol} {m.base.isTestFixture ? <TestTag>Test fixture</TestTag> : m.base.verified ? <span className="tag" data-tone="verified">Verified</span> : <span className="tag">Unverified</span>}
                  </strong>
                  <span>{m.base.name}</span>
                </span>
                <span className="num t-small">{price(m.poolPrice)}</span>
              </button>
              <div className={styles.address}>
                <Address value={m.base.address} />
              </div>
            </li>
          ))}
          {rows.length === 0 ? <li className="empty">No token matches this search.</li> : null}
        </ul>
      </Dialog>
    </div>
  );
}
