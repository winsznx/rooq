"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import { isAddress, getAddress } from "viem";
import { clearingHouseAbi, formatBps, formatFixed, shortAddress } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import { findMarket, useMarketSnapshots } from "@/lib/chain-data";
import { useMakerAccount } from "@/lib/maker-data";
import { oiUsage, price } from "@/lib/display";
import { useTxRunner } from "@/lib/tx";
import { TxProgress } from "@/components/feedback/tx-progress";
import { AssetEmblem, PerpStatusPill, StateBlock } from "@/components/primitives";
import { WalletGate } from "@/components/wallet";
import { BackingDialog } from "../backing-dialog";
import styles from "../makers.module.css";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * MK02. Risk controls a maker actually has onchain: backing, the delegated quote signer and the nonce
 * floor. Quote bands live in the maker's own service config, never in this browser.
 */
export function MakerMarket({ marketKey }: { marketKey: string }) {
  const { address } = useAccount();
  const { data: markets, isLoading } = useMarketSnapshots();
  const { data: maker } = useMakerAccount(address);
  const signerTx = useTxRunner();
  const nonceTx = useTxRunner();
  const [signerText, setSignerText] = useState("");
  const [dialog, setDialog] = useState<"commit" | "withdraw" | null>(null);
  const m = findMarket(markets, marketKey);

  if (isLoading) return <StateBlock kind="loading" title="Reading the market" />;
  if (!m || !DEPLOYMENT) {
    return (
      <div className={styles.page}>
        <StateBlock kind="empty" title="No perp market matches this key" actions={<Link className="btn btn-sm" href="/app/makers">Maker desk</Link>} />
      </div>
    );
  }
  const dep = DEPLOYMENT;
  const mine = maker?.rows[m.marketId]?.committed ?? null;
  const signerValid = isAddress(signerText.trim());
  const usedBps = m.risk && m.oiUsdWad !== null && m.risk.maxOiUsdWad > 0n ? (m.oiUsdWad * 10_000n) / m.risk.maxOiUsdWad : null;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className="row" style={{ "--gap": "10px" } as React.CSSProperties}>
          <AssetEmblem logoUrl={m.base.logoUrl} assetClass={m.base.assetClass} size={40} label={m.base.symbol} />
          <h1 className="t-section">{`${m.base.symbol} maker`}</h1>
          <PerpStatusPill status={m.perpStatus} fresh={m.markFresh} />
        </div>
        <Link href="/app/makers" className="btn">
          All markets
        </Link>
      </header>

      <div className={styles.detail}>
        <section aria-label="Backing">
          <div className="panel-head">
            <h2 className="t-label" style={{ margin: 0 }}>
              Backing
            </h2>
          </div>
          <div className={styles.body}>
            <dl className="facts">
              <div>
                <dt>Your committed backing</dt>
                <dd>{mine === null ? "—" : `${formatFixed(mine, m.quote.decimals, 2)} ${m.quote.symbol}`}</dd>
              </div>
              <div>
                <dt>Market backing, all makers</dt>
                <dd>{`${formatFixed(m.makerBacking, m.quote.decimals, 2)} ${m.quote.symbol}`}</dd>
              </div>
              <div>
                <dt>Minimum while perps are active</dt>
                <dd>{m.risk ? `${formatFixed(m.risk.minMakerBacking, m.quote.decimals, 0)} ${m.quote.symbol}` : "—"}</dd>
              </div>
              <div>
                <dt>Open interest / cap</dt>
                <dd>
                  {oiUsage(m)}
                  <span className="sub">{usedBps === null ? "" : `${formatBps(usedBps)} used`}</span>
                </dd>
              </div>
              <div>
                <dt>{copy.perps.markPrice}</dt>
                <dd>{price(m.mark)}</dd>
              </div>
            </dl>
            <WalletGate>
              <div className="row wrap">
                <button type="button" className="btn btn-primary" onClick={() => setDialog("commit")}>
                  Commit backing
                </button>
                <button type="button" className="btn" disabled={!mine} onClick={() => setDialog("withdraw")}>
                  Withdraw backing
                </button>
              </div>
            </WalletGate>
            <p className="t-small muted" style={{ margin: 0 }}>
              Your margin inside open positions is not part of committed backing and can&apos;t be withdrawn until those positions close or are liquidated.
            </p>
          </div>
        </section>

        <section aria-label="Quote controls">
          <div className="panel-head">
            <h2 className="t-label" style={{ margin: 0 }}>
              Quote controls
            </h2>
          </div>
          <div className={styles.body}>
            <dl className="facts">
              <div>
                <dt>Delegated quote signer</dt>
                <dd>{!maker ? "—" : maker.quoteSigner === ZERO ? "None" : shortAddress(maker.quoteSigner)}</dd>
              </div>
              <div>
                <dt>Nonce floor</dt>
                <dd>{maker ? maker.nonceFloor.toString() : "—"}</dd>
              </div>
            </dl>
            <label className="field">
              <span className="field-label">New quote signer address</span>
              <input className="input-text num" value={signerText} onChange={(e) => setSignerText(e.target.value)} placeholder="0x..." spellCheck={false} autoComplete="off" />
              <span className="field-help">The signer can sign quotes for your account. It can never deposit, withdraw or move collateral. Changing it takes effect in the same block.</span>
            </label>
            <WalletGate>
              <div className="row wrap">
                <button
                  type="button"
                  className="btn"
                  disabled={!signerValid || signerTx.busy}
                  onClick={() => void signerTx.run([{ label: "Set quote signer", address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "setQuoteSigner", args: [getAddress(signerText.trim())] }], { kind: "maker" })}
                >
                  Set signer
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={!maker || maker.quoteSigner === ZERO || signerTx.busy}
                  onClick={() => void signerTx.run([{ label: "Revoke quote signer", address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "setQuoteSigner", args: [ZERO] }], { kind: "maker" })}
                >
                  Revoke signer
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={!maker || nonceTx.busy}
                  onClick={() => {
                    if (!maker) return;
                    const fromClock = BigInt(Date.now()) * 1_000_000n;
                    const nextFloor = fromClock > maker.nonceFloor ? fromClock : maker.nonceFloor + 1n;
                    void nonceTx.run([{ label: "Cancel all outstanding quotes", address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "raiseNonceFloor", args: [nextFloor] }], { kind: "maker" });
                  }}
                >
                  Cancel all outstanding quotes
                </button>
              </div>
            </WalletGate>
            <p className="t-small muted" style={{ margin: 0 }}>
              Cancelling raises your nonce floor so every quote signed before now can no longer fill. To stop quoting entirely, revoke the signer and cancel outstanding quotes. Rooq never stores keys or signed quotes in this browser.
            </p>
            <TxProgress steps={signerTx.steps} />
            <TxProgress steps={nonceTx.steps} />
          </div>
        </section>
      </div>
      {dialog ? <BackingDialog m={m} action={dialog} open onOpenChange={(o) => !o && setDialog(null)} /> : null}
    </div>
  );
}
