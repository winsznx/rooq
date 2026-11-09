"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import { absBig, fee as feeFor, formatFixed, pnlFloor, pnlTrunc, scaleFor } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import type { MarketSnapshot, PositionSnapshot } from "@/lib/chain-data";
import { requestPerpQuote, QuoteRefused, type SignedQuote } from "@/lib/quotes";
import { useChainNow } from "@/lib/use-now";
import { collateral, percentDistance, price, toneOf } from "@/lib/display";
import { AssetEmblem, StateBlock } from "../primitives";
import { ReviewTradeDialog } from "./review-dialog";

interface CloseState {
  readonly position: PositionSnapshot;
  readonly market: MarketSnapshot;
  readonly fill: bigint;
  readonly quote: SignedQuote;
}

/** Positions with Reduce and Close. Each action fetches a fresh quote and goes through AC06. */
export function PositionsTable({ markets, positions, compact = false }: { markets: readonly MarketSnapshot[]; positions: readonly PositionSnapshot[]; compact?: boolean }) {
  const { address } = useAccount();
  const chainNow = useChainNow();
  const [closing, setClosing] = useState<CloseState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const start = async (p: PositionSnapshot, fraction: 1 | 2) => {
    const market = markets.find((m) => m.marketId === p.marketId);
    if (!market || !address) return;
    const fill = fraction === 1 ? -p.size : -(p.size / 2n);
    setPending(`${p.marketId}:${fraction}`);
    setNotice(null);
    try {
      const quote = await requestPerpQuote({ marketId: p.marketId, taker: address, size: fill });
      setClosing({ position: p, market, fill, quote });
    } catch (error) {
      setNotice(
        error instanceof QuoteRefused && error.reasonCode === "MARKET_PAUSED"
          ? copy.errors.paused
          : `${copy.perps.noLiquidity} Your position stays open and keeps its margin. Try again shortly, or see System status.`,
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      {notice ? (
        <p className="notice" data-tone="warning" role="alert" style={{ margin: 12 }}>
          {notice}
        </p>
      ) : null}
      {positions.length === 0 ? (
        <StateBlock
          kind="empty"
          title={copy.portfolio.empty}
          actions={
            <Link href="/app/markets" className="btn btn-sm">
              {copy.portfolio.openMarket}
            </Link>
          }
        />
      ) : (
      <div className="table-scroll">
        <table className="table table-cards">
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col" className="n">
                Size
              </th>
              <th scope="col" className="n">
                {copy.perps.entryPrice}
              </th>
              {!compact ? (
                <th scope="col" className="n">
                  {copy.perps.markPrice}
                </th>
              ) : null}
              <th scope="col" className="n">
                {copy.perps.liqPrice}
              </th>
              <th scope="col" className="n">
                {copy.perps.margin}
              </th>
              <th scope="col" className="n">
                {copy.portfolio.unrealizedPnl}
              </th>
              {!compact ? (
                <th scope="col" className="n">
                  Funding owed
                </th>
              ) : null}
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const m = markets.find((x) => x.marketId === p.marketId);
              if (!m) return null;
              const scale = scaleFor(m.quote.decimals);
              const upnl = p.mark === null ? null : pnlFloor(p.size, p.entryPrice, p.mark, scale);
              const long = p.size > 0n;
              const notional = p.mark === null ? null : (absBig(p.size) * p.mark) / 10n ** 18n / scale;
              return (
                <tr key={p.marketId}>
                  <td data-first>
                    <Link href={`/app/positions/me/${m.deployed.key}`} className="row" style={{ "--gap": "8px", textDecoration: "none" } as React.CSSProperties}>
                      <AssetEmblem logoUrl={m.base.logoUrl} assetClass={m.base.assetClass} size={24} label={m.base.symbol} />
                      <strong>{m.base.symbol}</strong>
                      <span className="tag" data-tone={long ? "long" : "short"}>
                        {long ? copy.perps.long : copy.perps.short}
                      </span>
                    </Link>
                  </td>
                  <td className="n" data-label="Size">
                    {`${formatFixed(absBig(p.size), 18, 4)} ${m.base.symbol}`}
                    <span style={{ display: "block", fontSize: 11, color: "var(--rq-ink-tertiary)" }}>{collateral(notional, m)}</span>
                  </td>
                  <td className="n" data-label={copy.perps.entryPrice}>{price(p.entryPrice)}</td>
                  {!compact ? (
                    <td className="n" data-label={copy.perps.markPrice}>
                      {price(p.mark)}
                      {!p.markFresh ? <span className="warn" style={{ display: "block", fontSize: 11 }}>Price delayed</span> : null}
                    </td>
                  ) : null}
                  <td className="n" data-label={copy.perps.liqPrice}>
                    {price(p.estLiquidationPrice)}
                    <span style={{ display: "block", fontSize: 11, color: "var(--rq-ink-tertiary)" }}>{percentDistance(p.mark, p.estLiquidationPrice)}</span>
                  </td>
                  <td className="n" data-label={copy.perps.margin}>{collateral(p.takerMargin, m)}</td>
                  <td className={`n ${toneOf(upnl) ?? ""}`} data-label={copy.portfolio.unrealizedPnl}>{collateral(upnl, m, { sign: "always" })}</td>
                  {!compact ? <td className="n" data-label="Funding owed">{collateral(p.pendingFunding, m, { sign: "always" })}</td> : null}
                  <td data-actions>
                    <span className="row" style={{ "--gap": "6px", justifyContent: "flex-end" } as React.CSSProperties}>
                      <button type="button" className="btn btn-sm" disabled={pending !== null || m.perpStatus === "PAUSED"} title={m.perpStatus === "PAUSED" ? copy.errors.paused : undefined} onClick={() => void start(p, 2)}>
                        {pending === `${p.marketId}:2` ? "Quoting" : "Reduce 50%"}
                      </button>
                      <button type="button" className="btn btn-danger btn-sm" disabled={pending !== null || m.perpStatus === "PAUSED"} title={m.perpStatus === "PAUSED" ? copy.errors.paused : undefined} onClick={() => void start(p, 1)}>
                        {pending === `${p.marketId}:1` ? "Quoting" : copy.perps.close}
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
      {closing ? (
        <ReviewTradeDialog
          open
          onOpenChange={(o) => {
            if (!o) setClosing(null);
          }}
          m={closing.market}
          side={closing.position.size > 0n ? "long" : "short"}
          signed={closing.fill}
          quote={closing.quote}
          margin={0n}
          fee={feeFor(absBig(closing.fill), closing.quote.quote.price, BigInt(closing.market.risk?.takerFeeBps ?? 0), scaleFor(closing.market.quote.decimals))}
          liq={closing.fill === -closing.position.size ? null : closing.position.estLiquidationPrice}
          leverageTenths={10}
          secondsLeft={chainNow === null ? null : Number(closing.quote.quote.deadline) - chainNow}
          intent={closing.fill === -closing.position.size ? "close" : "reduce"}
          realizedEstimate={pnlTrunc(-closing.fill, closing.position.entryPrice, closing.quote.quote.price, scaleFor(closing.market.quote.decimals))}
          onDone={() => undefined}
        />
      ) : null}
    </>
  );
}
