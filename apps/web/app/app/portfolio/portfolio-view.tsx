"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import { formatFixed, scaleFor } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { useAccountView } from "@/lib/account-view";
import { collateral } from "@/lib/display";
import { DepositDialog, WithdrawDialog } from "@/components/funds/funds-dialogs";
import { PositionsTable } from "@/components/trade/positions";
import { AssetEmblem, Sensitive, StateBlock, Tabs, TestTag, tabId, tabPanelId } from "@/components/primitives";
import { WalletGate, useWalletState } from "@/components/wallet";
import { AccountSummary, AccountSummarySkeleton, AccountUnavailable, HideValuesToggle } from "@/components/account/summary";
import styles from "./portfolio.module.css";

type Tab = "positions" | "holdings" | "liquidity";

/** P01. Holdings (tokens you own) and leveraged exposure (margin positions) are never summed together. */
export function PortfolioView() {
  const { address } = useAccount();
  const { wrongChain } = useWalletState();
  const view = useAccountView(address);
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("positions");
  const { acct, markets, figures: f } = view;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1 className={styles.title}>{copy.portfolio.title}</h1>
        {address ? <HideValuesToggle /> : null}
      </div>

      {wrongChain ? <p className="notice" data-tone="warning">{copy.errors.wrongNetwork}</p> : null}

      {view.status === "disconnected" ? (
        <StateBlock
          kind="locked"
          title="Connect a wallet to see your portfolio"
          body="Balances, holdings and positions are read from the chain. Nothing is shown until it can be verified."
          actions={
            <WalletGate>
              <span />
            </WalletGate>
          }
        />
      ) : null}
      {view.status === "loading" ? <AccountSummarySkeleton /> : null}
      {view.status === "unavailable" ? <AccountUnavailable onRetry={view.retry} /> : null}

      {view.status === "ready" && f && acct && markets ? (
        <>
          <AccountSummary
            f={f}
            stale={view.stale}
            lastReadAt={view.lastReadAt}
            actions={
              <>
                <button type="button" className="btn btn-primary" onClick={() => setDepositOpen(true)}>
                  {copy.portfolio.deposit}
                </button>
                <button type="button" className="btn" onClick={() => setWithdrawOpen(true)}>
                  {copy.portfolio.withdraw}
                </button>
              </>
            }
          />

          <Tabs
            group="portfolio"
            label="Portfolio sections"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "positions", label: `${copy.portfolio.positions} (${acct.positions.length})` },
              { value: "holdings", label: `${copy.portfolio.holdings} (${f.holdings.length})` },
              { value: "liquidity", label: `${copy.nav.liquidity} (${f.lps.length})` },
            ]}
          />

          <div role="tabpanel" id={tabPanelId("portfolio", tab)} aria-labelledby={tabId("portfolio", tab)} className={styles.panel}>
            {tab === "positions" ? (
              <>
                <p className={styles.note}>Isolated margin. You don&apos;t own these tokens.</p>
                <PositionsTable markets={markets} positions={acct.positions} />
              </>
            ) : tab === "holdings" ? (
              f.holdings.length === 0 ? (
                <StateBlock kind="empty" title="No tokens from Rooq markets in this wallet" actions={<Link href="/app/markets" className="btn btn-sm">{copy.portfolio.openMarket}</Link>} />
              ) : (
                <>
                  <table className="table table-cards">
                    <thead>
                      <tr>
                        <th scope="col">Token</th>
                        <th scope="col" className="n">Balance</th>
                        <th scope="col" className="n">Value, est.</th>
                        <th scope="col"><span className="sr-only">Action</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {f.holdings.map((m) => (
                        <tr key={m.marketId}>
                          <td data-first>
                            <span className="row" style={{ "--gap": "8px" } as React.CSSProperties}>
                              <AssetEmblem logoUrl={m.base.logoUrl} assetClass={m.base.assetClass} size={24} label={m.base.symbol} />
                              <strong>{m.base.symbol}</strong>
                              {m.base.isTestFixture ? <TestTag>Test fixture</TestTag> : null}
                            </span>
                          </td>
                          <td className="n" data-label="Balance"><Sensitive>{formatFixed(acct.baseBalances[m.marketId] ?? 0n, m.base.decimals, 4)}</Sensitive></td>
                          <td className="n faint" data-label="Value, est.">
                            <Sensitive>{m.poolPrice !== null ? collateral(((acct.baseBalances[m.marketId] ?? 0n) * m.poolPrice) / 10n ** 18n / scaleFor(m.quote.decimals), m) : "Unavailable"}</Sensitive>
                          </td>
                          <td data-actions style={{ textAlign: "right" }}>
                            <Link className="btn btn-sm" href={`/app/trade/${m.deployed.key}?mode=spot`}>
                              {copy.spot.sell}
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className={styles.note}>Values use each Rooq pool&apos;s current price. They are estimates, not an exit guarantee.</p>
                </>
              )
            ) : f.lps.length === 0 ? (
              <StateBlock kind="empty" title="No pool shares" actions={<Link href="/app/liquidity" className="btn btn-sm">{copy.liquidity.add}</Link>} />
            ) : (
              <table className="table table-cards">
                <thead>
                  <tr>
                    <th scope="col">Pool</th>
                    <th scope="col" className="n">Shares</th>
                    <th scope="col"><span className="sr-only">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {f.lps.map((m) => (
                    <tr key={m.marketId}>
                      <td data-first><strong>{`${m.base.symbol} / ${m.quote.symbol}`}</strong></td>
                      <td className="n" data-label="Shares"><Sensitive>{`${formatFixed(acct.lpShares[m.marketId] ?? 0n, 18, 6)} rqLP`}</Sensitive></td>
                      <td data-actions style={{ textAlign: "right" }}>
                        <Link className="btn btn-sm" href={`/app/liquidity/${m.deployed.key}`}>
                          {copy.liquidity.remove}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="t-small faint" style={{ margin: 0 }}>{`Read from the chain at block ${acct.blockNumber.toString()}.`}</p>
        </>
      ) : null}
      <DepositDialog open={depositOpen} onOpenChange={setDepositOpen} />
      <WithdrawDialog open={withdrawOpen} onOpenChange={setWithdrawOpen} />
    </div>
  );
}
