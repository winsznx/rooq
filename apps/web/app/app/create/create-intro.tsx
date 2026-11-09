"use client";

import Link from "next/link";
import { formatFixed, formatLeverageTenths } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import { useTiers } from "@/lib/create-data";
import { useCreateDraft } from "./create-store";
import styles from "./create.module.css";

/** C01. Explains what launching needs, with requirements read from the registry, not hardcoded. */
export function CreateIntro() {
  const { data: tiers, isLoading, isError } = useTiers();
  const { draft, reset } = useCreateDraft();
  const symbol = DEPLOYMENT?.collateralSymbol ?? "collateral";
  const decimals = DEPLOYMENT?.collateralDecimals ?? 6;
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className="t-page">{copy.preflight.title}</h1>
        <p className="muted" style={{ margin: 0, maxWidth: 640 }}>
          Launch a spot market for a token, and turn on leveraged trading in the same session when the market qualifies. There is no waiting period and no graduation step: each trading mode goes live as soon as its own requirements are met onchain.
        </p>
      </header>

      {draft.token ? (
        <div className={styles.draftBar}>
          <span>{`Your draft for ${draft.token.symbol} is saved in this browser.`}</span>
          <span className="row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>
              Discard
            </button>
            <Link className="btn btn-sm" href="/app/create/asset">
              Continue
            </Link>
          </span>
        </div>
      ) : null}

      <section className={styles.cards} aria-label="What creating a market involves">
        <div className={styles.card}>
          <h2 className="t-panel">{copy.preflight.spotLiquidity}</h2>
          <p className="t-small muted" style={{ margin: 0 }}>
            You seed a Rooq constant-product pool with the token and {symbol}. Your deposit sets the starting price and you receive LP shares you can withdraw later.
          </p>
        </div>
        <div className={styles.card}>
          <h2 className="t-panel">{copy.preflight.perpLaunch}</h2>
          <p className="t-small muted" style={{ margin: 0 }}>
            Perps need an approved price feed for this exact token, committed maker backing and a creator bond. If any of these is missing, the spot market can still launch and leverage stays off.
          </p>
        </div>
        <div className={styles.card}>
          <h2 className="t-panel">Fees and bond</h2>
          <p className="t-small muted" style={{ margin: 0 }}>
            Pool swap fees go to liquidity providers. Creators earn no fee share in this release. The bond is first-loss cover for your market and stays locked while the market can carry positions.
          </p>
        </div>
      </section>

      <section className="panel" aria-label="Current leverage requirements">
        <div className="panel-head">
          <h2 className="t-label" style={{ margin: 0 }}>
            Risk tiers available to creators
          </h2>
          <span className="t-small faint">Set by the protocol. Creators choose a tier but cannot loosen it.</span>
        </div>
        {isLoading ? (
          <p className="empty">Reading tiers from the market registry.</p>
        ) : isError || !tiers ? (
          <p className="empty">Requirements are unavailable because the chain could not be read. Try again shortly.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Tier</th>
                  <th scope="col" className="n">
                    Max leverage
                  </th>
                  <th scope="col" className="n">
                    Initial / maintenance margin
                  </th>
                  <th scope="col" className="n">
                    Min maker backing
                  </th>
                  <th scope="col" className="n">
                    Creator bond
                  </th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.name}</strong> <span className="t-small muted">{t.label}</span>
                    </td>
                    <td className="n">{formatLeverageTenths(t.maxLeverageTenths)}</td>
                    <td className="n">{`${formatFixed(t.imrWad * 100n, 18, 2)}% / ${formatFixed(t.mmrWad * 100n, 18, 2)}%`}</td>
                    <td className="n">{`${formatFixed(t.minMakerBacking, decimals, 0)} ${symbol}`}</td>
                    <td className="n">{`${formatFixed(t.minBond, decimals, 0)} ${symbol}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="t-small muted" style={{ margin: 0 }}>
        {copy.preflight.noGuarantee} Preflight checks are not an investment recommendation or a fraud check.
      </p>
      <div>
        <Link href="/app/create/asset" className="btn btn-primary btn-lg">
          Choose asset
        </Link>
      </div>
    </div>
  );
}
