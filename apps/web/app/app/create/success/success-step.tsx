"use client";

import Link from "next/link";
import { usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";
import { PERP_STATUS, PREFLIGHT_CHECKS, PREFLIGHT_VERDICT, SPOT_STATUS, formatFixed, marketPreflightAbi, marketRegistryAbi, mockERC20Abi, spotPoolAbi } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import { useTxRunner } from "@/lib/tx";
import { Address, PerpStatusPill, SpotStatusPill } from "@/components/primitives";
import { TxProgress } from "@/components/feedback/tx-progress";
import { WalletGate } from "@/components/wallet";
import { missingReason } from "../preflight-reasons";
import styles from "../create.module.css";

/** C07. Spot and perp activation are reported separately, straight from the registry. */
export function SuccessStep({ marketId }: { marketId: Hex | null }) {
  const client = usePublicClient();
  const activate = useTxRunner();
  const dep = DEPLOYMENT;
  const q = useQuery({
    queryKey: ["created-market", marketId],
    enabled: Boolean(client && dep && marketId),
    refetchInterval: 6_000,
    queryFn: async () => {
      if (!client || !dep || !marketId) return null;
      const market = await client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "getMarket", args: [marketId] });
      const [reserves, symbol, decimals, token0, eligibility] = await Promise.all([
        client.readContract({ address: market.pool, abi: spotPoolAbi, functionName: "getReserves" }),
        client.readContract({ address: market.base, abi: mockERC20Abi, functionName: "symbol" }),
        client.readContract({ address: market.base, abi: mockERC20Abi, functionName: "decimals" }),
        client.readContract({ address: market.pool, abi: spotPoolAbi, functionName: "token0" }),
        client.readContract({ address: dep.marketPreflight, abi: marketPreflightAbi, functionName: "previewEligibility", args: [marketId] }),
      ]);
      const baseIs0 = token0.toLowerCase() === market.base.toLowerCase();
      return {
        market,
        reserves,
        symbol,
        decimals,
        reserveBase: baseIs0 ? reserves[0] : reserves[1],
        reserveQuote: baseIs0 ? reserves[1] : reserves[0],
        mask: eligibility[0],
        verdict: PREFLIGHT_VERDICT[eligibility[1]] ?? "BLOCKED",
      };
    },
  });

  if (!marketId || !dep) {
    return (
      <div className={styles.page}>
        <p className="empty">
          No market was given.
          <Link className="btn" href="/app/create">
            {copy.preflight.title}
          </Link>
        </p>
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className={styles.page}>
        <p className="notice" data-tone="warning" role="alert">
          This market could not be read from the registry. If you just created it, wait for the transaction to confirm and refresh.
        </p>
      </div>
    );
  }
  const d = q.data;
  const spotStatus = d ? (SPOT_STATUS[d.market.spotStatus] ?? "NONE") : null;
  const perpStatus = d ? (PERP_STATUS[d.market.perpStatus] ?? "NONE") : null;
  const funded = Boolean(d && d.reserves[0] > 0n && d.reserves[1] > 0n);
  const canActivate = Boolean(d && d.verdict === "READY" && (perpStatus === "REGISTERED" || perpStatus === "CLOSE_ONLY"));
  const missing = d ? PREFLIGHT_CHECKS.filter((c) => (d.mask & c.bit) === 0n) : [];

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className="t-page">{d ? `${d.symbol} market created` : "Market created"}</h1>
        <p className="muted" style={{ margin: 0 }}>
          Each trading mode is shown with the status the registry reports right now.
        </p>
      </header>
      <div className={styles.cards} style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <section className="panel panel-pad stack" aria-label="Spot status">
          <span className="row between">
            <h2 className="t-panel">{copy.preflight.spotLiquidity}</h2>
            <SpotStatusPill status={spotStatus} funded={funded} />
          </span>
          <p className="t-small muted" style={{ margin: 0 }}>
            {funded ? "The pool holds liquidity on both sides and accepts swaps." : "The pool exists but holds no liquidity yet. Add liquidity before anyone can trade."}
          </p>
          {d ? <Address value={d.market.pool} /> : null}
        </section>
        <section className="panel panel-pad stack" aria-label="Perp status">
          <span className="row between">
            <h2 className="t-panel">{copy.perps.tab}</h2>
            <PerpStatusPill status={perpStatus} fresh={true} />
          </span>
          {perpStatus === "ACTIVE" ? (
            <p className="t-small" style={{ margin: 0 }}>
              Leverage is active. MarketPreflight confirmed every requirement onchain.
            </p>
          ) : perpStatus === "NONE" ? (
            <p className="t-small muted" style={{ margin: 0 }}>
              Leverage was not activated. This market has no perp configuration.
            </p>
          ) : (
            <>
              <p className="t-small muted" style={{ margin: 0 }}>
                Leverage was not activated yet. {canActivate ? "Every requirement passes now, so anyone can activate it." : "These requirements are still missing:"}
              </p>
              {!canActivate && missing.length > 0 ? (
                <ul className="t-small" style={{ margin: 0, paddingLeft: 18 }}>
                  {missing.map((c) => (
                    <li key={c.key}>{missingReason(c.key, dep.collateralSymbol)}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
          {canActivate ? (
            <WalletGate>
              <button
                type="button"
                className="btn btn-primary btn-block"
                disabled={activate.busy}
                onClick={() => void activate.run([{ label: "Activate perps (rechecked onchain)", address: dep.marketPreflight, abi: marketPreflightAbi, functionName: "activatePerps", args: [marketId] }], { kind: "market" }).then(() => q.refetch())}
              >
                Activate perps
              </button>
            </WalletGate>
          ) : null}
          <TxProgress steps={activate.steps} />
        </section>
      </div>
      <section className="panel panel-pad" aria-label="Contracts">
        <dl className="facts">
          <div>
            <dt>Market ID</dt>
            <dd className={styles.mono}>{marketId}</dd>
          </div>
          <div>
            <dt>Registry</dt>
            <dd>
              <Address value={dep.marketRegistry} />
            </dd>
          </div>
          <div>
            <dt>Pool reserves</dt>
            <dd>{d ? `${formatFixed(d.reserveBase, d.decimals, 4)} ${d.symbol} and ${formatFixed(d.reserveQuote, dep.collateralDecimals, 2)} ${dep.collateralSymbol}` : "—"}</dd>
          </div>
        </dl>
      </section>
      <div className={styles.actions}>
        <Link href="/app/makers" className="btn">
          Maker desk
        </Link>
        <Link href={`/app/trade/${marketId}?mode=spot`} className="btn btn-primary btn-lg">
          View market
        </Link>
      </div>
    </div>
  );
}
