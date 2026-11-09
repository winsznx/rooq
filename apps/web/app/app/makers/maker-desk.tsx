"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import { formatBps, formatFixed, shortAddress } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import { useMarketSnapshots, type MarketSnapshot } from "@/lib/chain-data";
import { useMakerAccount, useQuoteServiceHealth } from "@/lib/maker-data";
import { AssetEmblem, PerpStatusPill } from "@/components/primitives";
import { WalletGate, useWalletState } from "@/components/wallet";
import { BackingDialog } from "./backing-dialog";
import styles from "./makers.module.css";

const ZERO = "0x0000000000000000000000000000000000000000";

/** MK01. Real pledged capital and exposure for the connected maker wallet. */
export function MakerDesk() {
  const { address } = useAccount();
  const { isConnected, wrongChain } = useWalletState();
  const { data: markets, isLoading } = useMarketSnapshots();
  const { data: maker } = useMakerAccount(isConnected && !wrongChain ? address : undefined);
  const health = useQuoteServiceHealth();
  const [dialog, setDialog] = useState<{ m: MarketSnapshot; action: "commit" | "withdraw" } | null>(null);
  const perpMarkets = (markets ?? []).filter((m) => m.hasPerps);
  const ready = isConnected && !wrongChain;
  const unit = DEPLOYMENT?.collateralSymbol ?? "";
  const decimals = DEPLOYMENT?.collateralDecimals ?? 6;
  const utilization = maker && maker.inPositions + maker.committedTotal > 0n ? (maker.inPositions * 10_000n) / (maker.inPositions + maker.committedTotal) : null;
  const releasable = maker
    ? perpMarkets.reduce((sum, m) => {
        const committed = maker.rows[m.marketId]?.committed ?? 0n;
        const min = m.risk?.minMakerBacking ?? 0n;
        const headroom = m.perpStatus === "ACTIVE" ? (m.makerBacking > min ? m.makerBacking - min : 0n) : m.makerBacking;
        return sum + (committed < headroom ? committed : headroom);
      }, maker.vaultFree)
    : 0n;
  const total = maker ? maker.vaultFree + maker.committedTotal + maker.inPositions : 0n;
  const serviceIsYours = Boolean(health.data && address && health.data.maker.toLowerCase() === address.toLowerCase());
  const signerMatches = Boolean(serviceIsYours && maker && health.data && maker.quoteSigner.toLowerCase() === health.data.signer.toLowerCase());

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <h1 className="t-page">Maker desk</h1>
          <p className="muted" style={{ margin: "8px 0 0", maxWidth: 640 }}>
            Quote markets. Set your risk. Committed backing pays for your side of every fill; nothing is quoted beyond what is committed onchain.
          </p>
        </div>
      </header>

      <section className={styles.capital} aria-label="Your maker capital">
        <div className={styles.capitalHead}>
          <div>
            <h2 className={styles.capitalLabel}>Releasable now</h2>
            <p className={styles.capitalValue}>
              {maker ? formatFixed(releasable, decimals, 2) : <span className={styles.dash}>Connect to see</span>}
              {maker ? <span className={styles.capitalUnit}>{unit}</span> : null}
            </p>
          </div>
          <dl className={styles.utilisation}>
            <div>
              <dt>Utilisation</dt>
              <dd className="num">{utilization === null ? "—" : formatBps(utilization)}</dd>
            </div>
            {maker ? (
              <div>
                <dt>Creator bonds</dt>
                <dd className="num">{`${formatFixed(maker.bondTotal, decimals, 2)} ${unit}`}</dd>
              </div>
            ) : null}
          </dl>
        </div>
        {maker && total > 0n ? (
          <div className={styles.allocation} role="img" aria-label={`Free ${formatFixed(maker.vaultFree, decimals, 2)}, committed ${formatFixed(maker.committedTotal, decimals, 2)}, reserved in positions ${formatFixed(maker.inPositions, decimals, 2)} ${unit}`}>
            <span data-part="free" style={{ flexGrow: Number((maker.vaultFree * 1000n) / total) }} />
            <span data-part="committed" style={{ flexGrow: Number((maker.committedTotal * 1000n) / total) }} />
            <span data-part="reserved" style={{ flexGrow: Number((maker.inPositions * 1000n) / total) }} />
          </div>
        ) : null}
        <dl className={styles.parts}>
          <div>
            <dt data-part="free">Free in vault</dt>
            <dd className="num">{maker ? `${formatFixed(maker.vaultFree, decimals, 2)} ${unit}` : "—"}</dd>
          </div>
          <div>
            <dt data-part="committed">Committed</dt>
            <dd className="num">{maker ? `${formatFixed(maker.committedTotal, decimals, 2)} ${unit}` : "—"}</dd>
          </div>
          <div>
            <dt data-part="reserved">Reserved in positions</dt>
            <dd className="num">{maker ? `${formatFixed(maker.inPositions, decimals, 2)} ${unit}` : "—"}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.service} aria-label="Quote service">
        <div className="row between wrap">
          <h2 className="t-label" style={{ margin: 0 }}>
            Quote service
          </h2>
          {health.isError ? (
            <span className="pill" data-tone="warning">
              Offline
            </span>
          ) : health.data ? (
            <span className="pill" data-tone={health.data.status === "quoting" ? "positive" : "warning"}>
              {health.data.status === "quoting" ? "Quoting" : "Paused"}
            </span>
          ) : (
            <span className="pill" data-tone="neutral">
              Checking
            </span>
          )}
        </div>
        <dl className="facts">
          <div>
            <dt>Maker account</dt>
            <dd>{health.data ? shortAddress(health.data.maker) : "—"}</dd>
          </div>
          <div>
            <dt>Signing key</dt>
            <dd>
              {health.data ? shortAddress(health.data.signer) : "—"}
              <span className="sub">A delegated key that can sign quotes but can&apos;t move funds</span>
            </dd>
          </div>
          {maker ? (
            <div>
              <dt>Your onchain quote signer</dt>
              <dd>
                {maker.quoteSigner === ZERO ? "None. Only your wallet key can sign." : shortAddress(maker.quoteSigner)}
                {serviceIsYours ? <span className="sub">{signerMatches ? "Matches the running service" : "Does not match the running service"}</span> : null}
              </dd>
            </div>
          ) : null}
        </dl>
        {health.isError ? (
          <p className="t-small muted" style={{ margin: 0 }}>
            The quote service did not respond. No new fills can happen without signed quotes; existing positions are unaffected.
          </p>
        ) : null}
      </section>

      {!ready ? (
        <div style={{ maxWidth: 360 }}>
          <WalletGate>{null}</WalletGate>
        </div>
      ) : null}

      <section className={styles.table} aria-label="Markets you can back">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Market</th>
                <th scope="col">Status</th>
                <th scope="col" className="n">
                  Market backing
                </th>
                <th scope="col" className="n">
                  Minimum
                </th>
                <th scope="col" className="n">
                  Yours
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6}>Reading markets.</td>
                </tr>
              ) : (
                perpMarkets.map((m) => (
                  <tr key={m.marketId}>
                    <td>
                      <Link href={`/app/makers/${m.deployed.key}`} className="row" style={{ "--gap": "8px", textDecoration: "none" } as React.CSSProperties}>
                        <AssetEmblem logoUrl={m.base.logoUrl} assetClass={m.base.assetClass} size={24} label={m.base.symbol} />
                        <strong>{m.base.symbol}</strong>
                      </Link>
                    </td>
                    <td>
                      <PerpStatusPill status={m.perpStatus} fresh={m.markFresh} />
                    </td>
                    <td className="n">{`${formatFixed(m.makerBacking, m.quote.decimals, 2)} ${m.quote.symbol}`}</td>
                    <td className="n">{m.risk ? `${formatFixed(m.risk.minMakerBacking, m.quote.decimals, 0)} ${m.quote.symbol}` : "—"}</td>
                    <td className="n">{maker ? `${formatFixed(maker.rows[m.marketId]?.committed ?? 0n, m.quote.decimals, 2)} ${m.quote.symbol}` : "—"}</td>
                    <td>
                      {ready ? (
                        <span className="row" style={{ "--gap": "6px", justifyContent: "flex-end" } as React.CSSProperties}>
                          <button type="button" className="btn btn-sm" onClick={() => setDialog({ m, action: "commit" })}>
                            Commit
                          </button>
                          <button type="button" className="btn btn-sm" disabled={!maker || (maker.rows[m.marketId]?.committed ?? 0n) === 0n} onClick={() => setDialog({ m, action: "withdraw" })}>
                            {copy.portfolio.withdraw}
                          </button>
                        </span>
                      ) : (
                        <span className="t-small faint">Connect to manage</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ul className={styles.cards}>
        {perpMarkets.map((m) => (
          <li key={m.marketId} className={styles.card}>
            <div className="row between">
              <Link href={`/app/makers/${m.deployed.key}`} className="row" style={{ "--gap": "8px" } as React.CSSProperties}>
                <AssetEmblem logoUrl={m.base.logoUrl} assetClass={m.base.assetClass} size={24} label={m.base.symbol} />
                <strong>{m.base.symbol}</strong>
              </Link>
              <PerpStatusPill status={m.perpStatus} fresh={m.markFresh} />
            </div>
            <dl className="facts">
              <div>
                <dt>Market backing</dt>
                <dd>{`${formatFixed(m.makerBacking, m.quote.decimals, 2)} ${m.quote.symbol}`}</dd>
              </div>
              <div>
                <dt>Yours</dt>
                <dd>{maker ? `${formatFixed(maker.rows[m.marketId]?.committed ?? 0n, m.quote.decimals, 2)} ${m.quote.symbol}` : "—"}</dd>
              </div>
            </dl>
            <Link className="btn btn-block" href={`/app/makers/${m.deployed.key}`}>
              Manage
            </Link>
          </li>
        ))}
      </ul>

      {dialog ? <BackingDialog m={dialog.m} action={dialog.action} open onOpenChange={(o) => !o && setDialog(null)} /> : null}
    </div>
  );
}
