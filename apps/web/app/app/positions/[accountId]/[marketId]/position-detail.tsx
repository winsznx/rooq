"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { isAddress, type Address } from "viem";
import { formatFixed, pnlFloor, scaleFor } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { findMarket, useAccountSnapshot, useMarketSnapshots } from "@/lib/chain-data";
import { useTrades } from "@/lib/api-hooks";
import { collateral, percentDistance, price, toneOf } from "@/lib/display";
import { PositionsTable } from "@/components/trade/positions";
import { AssetEmblem, PerpStatusPill, StateBlock } from "@/components/primitives";
import { WalletGate } from "@/components/wallet";
import styles from "./position.module.css";

/** Where mark, entry and estimated liquidation sit relative to each other. Correct for long and short. */
function PriceLadder({ entry, mark, liq, long }: { entry: bigint; mark: bigint | null; liq: bigint | null; long: boolean }) {
  if (mark === null || liq === null) return null;
  const min = [entry, mark, liq].reduce((a, b) => (b < a ? b : a));
  const max = [entry, mark, liq].reduce((a, b) => (b > a ? b : a));
  const span = max === min ? 1n : max - min;
  const at = (v: bigint) => Number(((v - min) * 1000n) / span) / 10;
  const stops = [
    { key: "liq", label: "Est. liquidation", value: liq, pos: at(liq), tone: "liq" },
    { key: "entry", label: "Entry", value: entry, pos: at(entry), tone: "entry" },
    { key: "mark", label: "Mark", value: mark, pos: at(mark), tone: "mark" },
  ];
  return (
    <div className={styles.ladder} role="img" aria-label={`Estimated liquidation ${price(liq)}, entry ${price(entry)}, mark ${price(mark)}. ${long ? "Long: liquidation is below." : "Short: liquidation is above."}`}>
      <div className={styles.rail}>
        {stops.map((s) => (
          <span key={s.key} className={styles.stop} data-tone={s.tone} style={{ left: `${Math.min(100, Math.max(0, s.pos))}%` }} />
        ))}
      </div>
      <p className={styles.ladderKey}>
        {stops.map((s) => (
          <span key={s.key} data-tone={s.tone}>
            <i aria-hidden />
            {s.label} <b className="num">{price(s.value)}</b>
          </span>
        ))}
      </p>
    </div>
  );
}

/** P02. Reduce and close fetch fresh quotes; nothing here promises a guaranteed exit. */
export function PositionDetail({ account, marketKey }: { account: string; marketKey: string }) {
  const { address } = useAccount();
  const isSelf = account === "me";
  const owner = isSelf ? address : isAddress(account) ? (account as Address) : undefined;
  const valid = isSelf || isAddress(account);
  const { data: markets } = useMarketSnapshots();
  const { data: acct } = useAccountSnapshot(owner);
  const m = findMarket(markets, marketKey);
  const p = acct?.positions.find((x) => x.marketId === m?.marketId);
  const fills = useTrades(m?.marketId);
  const own = Boolean(address && owner && address.toLowerCase() === owner.toLowerCase());

  if (!valid) return <StateBlock kind="empty" title="This is not a valid account address" />;
  if (isSelf && !address) return <StateBlock kind="locked" title="Connect a wallet to see this position" actions={<WalletGate><span /></WalletGate>} />;
  if (!m) return <StateBlock kind="empty" title="Market not found" />;

  const scale = scaleFor(m.quote.decimals);
  const upnl = p && p.mark !== null ? pnlFloor(p.size, p.entryPrice, p.mark, scale) : null;
  const myFills = (fills.data?.trades ?? []).filter((t) => t.kind === "perp" && t.account.toLowerCase() === owner?.toLowerCase());
  const long = p ? p.size > 0n : true;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <span className="row" style={{ "--gap": "10px" } as React.CSSProperties}>
          <AssetEmblem logoUrl={m.base.logoUrl} assetClass={m.base.assetClass} size={32} label={m.base.symbol} />
          <h1 className={styles.title}>{`${m.base.symbol} position`}</h1>
          <PerpStatusPill status={m.perpStatus} fresh={m.markFresh} />
        </span>
        <Link className="btn btn-sm" href={`/app/trade/${m.deployed.key}?mode=perps`}>
          Open the market
        </Link>
      </header>
      {!p ? (
        <StateBlock kind="empty" title={copy.portfolio.empty} actions={<Link className="btn btn-sm" href="/app/markets">{copy.portfolio.openMarket}</Link>} />
      ) : (
        <>
          <section className={styles.lead} aria-label="Position summary">
            <div>
              <p className={styles.side} data-side={long ? "long" : "short"}>{long ? copy.perps.long : copy.perps.short}</p>
              <p className={styles.size}>{`${formatFixed(p.size < 0n ? -p.size : p.size, 18, 4)} ${m.base.symbol}`}</p>
            </div>
            <dl className={styles.leadFacts}>
              <div>
                <dt>Equity after funding</dt>
                <dd className={p.liquidatable ? "num neg" : "num"}>{collateral(p.takerEquity, m)}</dd>
              </div>
              <div>
                <dt>Margin</dt>
                <dd className="num">{collateral(p.takerMargin, m)}</dd>
              </div>
              <div>
                <dt>{copy.portfolio.unrealizedPnl}</dt>
                <dd className={`num ${toneOf(upnl) ?? ""}`}>{collateral(upnl, m, { sign: "always" })}</dd>
              </div>
            </dl>
          </section>
          {p.liquidatable ? <p className="notice" data-tone="negative">Equity is below maintenance margin. This position can be liquidated.</p> : null}
          <PriceLadder entry={p.entryPrice} mark={p.mark} liq={p.estLiquidationPrice} long={long} />
          <p className={styles.note}>{`${percentDistance(p.mark, p.estLiquidationPrice)} from mark to estimated liquidation. An estimate, not a guaranteed exit.`}</p>
          {!p.markFresh ? <p className="notice" data-tone="warning">{copy.errors.oracleStale}</p> : null}
          {own && markets ? (
            <section aria-label="Actions" className={styles.section}>
              <h2 className={styles.sectionTitle}>{`${copy.perps.reduce} or ${copy.perps.close.toLowerCase()}`}</h2>
              <span className={styles.note}>Each action asks the maker for a fresh quote.</span>
              <PositionsTable markets={markets} positions={[p]} compact />
            </section>
          ) : (
            <p className="t-small muted">You are viewing another account. Actions are available only to the account owner.</p>
          )}
          <section aria-label="Details" className={styles.section}>
            <h2 className={styles.sectionTitle}>Details</h2>
            <dl className="facts" data-ruled="true">
              <div>
                <dt>{copy.perps.entryPrice}</dt>
                <dd>{price(p.entryPrice)}</dd>
              </div>
              <div>
                <dt>{copy.perps.markPrice}</dt>
                <dd>{price(p.mark)}</dd>
              </div>
              <div>
                <dt>Maintenance requirement</dt>
                <dd>{collateral(p.maintenanceMargin, m)}</dd>
              </div>
              <div>
                <dt>{copy.portfolio.realizedPnl}</dt>
                <dd className={toneOf(p.realizedPnl)}>{collateral(p.realizedPnl, m, { sign: "always" })}</dd>
              </div>
              <div>
                <dt>Funding owed (unsettled)</dt>
                <dd>{collateral(p.pendingFunding, m, { sign: "always" })}</dd>
              </div>
              <div>
                <dt>Maker</dt>
                <dd>{p.maker}</dd>
              </div>
            </dl>
          </section>
        </>
      )}
      <section aria-label="Fills" className={styles.section}>
        <h2 className={styles.sectionTitle}>Fills</h2>
        {fills.isError ? (
          <StateBlock kind="unavailable" title="Fill history is unavailable" body="The indexer API is offline. The position above still comes straight from the chain." />
        ) : myFills.length === 0 ? (
          <p className={styles.note}>{copy.activity.empty}</p>
        ) : (
          <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Block</th>
                <th scope="col" className="n">Size</th>
                <th scope="col" className="n">Price</th>
                <th scope="col" className="n">Fee</th>
              </tr>
            </thead>
            <tbody>
              {myFills.map((t) => (
                <tr key={`${t.txHash}-${t.logIndex}`}>
                  <td className="num">{t.blockNumber}</td>
                  <td className={`n ${BigInt(t.size) >= 0n ? "pos" : "neg"}`}>{formatFixed(BigInt(t.size), 18, 4, { sign: "always" })}</td>
                  <td className="n">{price(BigInt(t.price))}</td>
                  <td className="n">{collateral(BigInt(t.fee), m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </div>
  );
}
