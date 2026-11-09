"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { formatAge, formatFixed, formatLeverageTenths, formatPrice, parseDecimal, shortAddress } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import { useApprovedFeeds, useTiers } from "@/lib/create-data";
import { useChainNow } from "@/lib/use-now";
import { AmountField } from "@/components/funds/amount-field";
import { useCreateDraft } from "../create-store";
import { CreateSteps } from "../steps";
import styles from "../create.module.css";

const WAD = 10n ** 18n;

/** C04. Configure a perp at launch. Nothing here activates leverage; MarketPreflight decides onchain. */
export function LeverageStep() {
  const router = useRouter();
  const { draft, update } = useCreateDraft();
  const token = draft.token;
  const dep = DEPLOYMENT;
  const feeds = useApprovedFeeds(token?.address ?? null);
  const tiers = useTiers();
  const chainNow = useChainNow();
  const initialTier = tiers.data?.find((t) => t.id === draft.tierId) ?? null;
  const needsDefaults = draft.maxOiUsdText === "" && draft.plannedBackingText === "" && draft.bondText === "";

  useEffect(() => {
    if (!initialTier || !needsDefaults || !dep) return;
    update({
      maxOiUsdText: formatFixed(initialTier.maxOiUsdWad, 18, 0, { group: false }),
      plannedBackingText: formatFixed(initialTier.minMakerBacking, dep.collateralDecimals, 0, { group: false }),
      bondText: formatFixed(initialTier.minBond, dep.collateralDecimals, 0, { group: false }),
    });
  }, [initialTier, needsDefaults, dep, update]);

  if (!token || !dep) {
    return (
      <div className={styles.page}>
        <CreateSteps current={2} />
        <p className="empty">
          Choose an asset first.
          <Link className="btn" href="/app/create/asset">
            Choose asset
          </Link>
        </p>
      </div>
    );
  }

  const tier = tiers.data?.find((t) => t.id === draft.tierId) ?? null;
  const maxOiUsd = parseDecimal(draft.maxOiUsdText, 0);
  const maxOiWad = maxOiUsd === null ? null : maxOiUsd * WAD;
  const oiTooHigh = tier !== null && maxOiWad !== null && maxOiWad > tier.maxOiUsdWad;
  const backing = parseDecimal(draft.plannedBackingText, dep.collateralDecimals);
  const bond = parseDecimal(draft.bondText, dep.collateralDecimals);
  const noFeed = feeds.isSuccess && feeds.data.length === 0;
  const feedChosen = draft.feedId !== null && (feeds.data ?? []).some((f) => f.feedId === draft.feedId);
  const canContinue = !draft.perps || (feedChosen && tier !== null && maxOiWad !== null && maxOiWad > 0n && !oiTooHigh && backing !== null && bond !== null);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <CreateSteps current={2} />
        <h1 className="t-page">{copy.preflight.perpLaunch}</h1>
        <p className="muted" style={{ margin: 0 }}>
          Leverage turns on at launch only if every requirement passes onchain. If it does not, your spot market still launches and leverage stays off.
        </p>
      </header>
      <div className={styles.layout}>
        <div className={styles.main}>
          <label className={styles.option}>
            <input type="checkbox" checked={draft.perps} onChange={(e) => update({ perps: e.target.checked })} />
            <span className={styles.optionText}>
              <strong>{copy.preflight.perpLaunch}</strong>
              <span className="t-small muted">Isolated perpetuals settled in {dep.collateralSymbol}, backed by maker collateral.</span>
            </span>
          </label>

          {draft.perps ? (
            <>
              <section className="panel panel-pad stack" aria-label={copy.preflight.feed}>
                <h2 className="t-panel">{copy.preflight.feed}</h2>
                {feeds.isLoading ? <p className="t-small muted">Looking for approved feeds for this token.</p> : null}
                {feeds.isError ? (
                  <p className="notice" data-tone="warning" role="alert">
                    Approved feeds could not be read from the chain. Try again shortly.
                  </p>
                ) : null}
                {noFeed ? (
                  <div className="notice" data-tone="warning" role="status">
                    <span>
                      <strong>No reliable price feed is available.</strong> {copy.preflight.sourceMissing} On testnet, feeds are approved by the oracle admin, and a pool you create cannot price its own perps. This market can launch as spot only.{" "}
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => {
                          update({ perps: false, feedId: null });
                          router.push("/app/create/preflight");
                        }}
                      >
                        {copy.preflight.spotOnly}
                      </button>
                    </span>
                  </div>
                ) : null}
                <div className={styles.choice}>
                  {(feeds.data ?? []).map((f) => (
                    <label key={f.feedId} className={styles.option}>
                      <input type="radio" name="feed" checked={draft.feedId === f.feedId} onChange={() => update({ feedId: f.feedId })} />
                      <span className={styles.optionText}>
                        <strong>{f.description ?? "Price feed"}</strong>
                        <span className="t-small muted">{`Feed ${shortAddress(f.aggregator)}, heartbeat ${f.heartbeat}s`}</span>
                      </span>
                      <span className="num t-small" style={{ textAlign: "right" }}>
                        {formatPrice(f.price)}
                        <span className={f.fresh ? "faint" : "warn"} style={{ display: "block" }}>
                          {f.updatedAt !== null && chainNow !== null ? `Updated ${formatAge(chainNow - f.updatedAt)}` : "—"}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              <section className="panel panel-pad stack" aria-label="Risk tier">
                <h2 className="t-panel">{copy.preflight.marketLimits}</h2>
                {tiers.isError ? <p className="notice">Risk tiers could not be read. Try again shortly.</p> : null}
                <div className={styles.choice}>
                  {(tiers.data ?? []).map((t) => (
                    <label key={t.id} className={styles.option}>
                      <input
                        type="radio"
                        name="tier"
                        checked={draft.tierId === t.id}
                        onChange={() =>
                          update({
                            tierId: t.id,
                            maxOiUsdText: formatFixed(t.maxOiUsdWad, 18, 0, { group: false }),
                            plannedBackingText: formatFixed(t.minMakerBacking, dep.collateralDecimals, 0, { group: false }),
                            bondText: formatFixed(t.minBond, dep.collateralDecimals, 0, { group: false }),
                          })
                        }
                      />
                      <span className={styles.optionText}>
                        <strong>{`Tier ${t.name}: ${t.label}`}</strong>
                        <span className="t-small muted">{`Initial margin ${formatFixed(t.imrWad * 100n, 18, 2)}%, maintenance ${formatFixed(t.mmrWad * 100n, 18, 2)}%, taker fee ${formatFixed(BigInt(t.takerFeeBps), 2, 2)}%`}</span>
                      </span>
                      <span className="num">{`${formatLeverageTenths(t.maxLeverageTenths)} max`}</span>
                    </label>
                  ))}
                </div>
                <AmountField
                  label="Open interest cap"
                  value={draft.maxOiUsdText}
                  onChange={(v) => update({ maxOiUsdText: v.replace(/\..*/, "") })}
                  decimals={0}
                  unit="USD"
                  error={oiTooHigh && tier ? `This tier allows at most ${formatFixed(tier.maxOiUsdWad, 18, 0)} USD.` : null}
                  help="Total position size the market can carry, at the mark price. You can only choose a lower cap than the tier allows."
                />
              </section>

              <section className="panel panel-pad stack" aria-label={copy.preflight.makerBacking}>
                <h2 className="t-panel">{`${copy.preflight.makerBacking} and ${copy.preflight.creatorBond.toLowerCase()}`}</h2>
                <AmountField
                  label="Planned maker backing"
                  value={draft.plannedBackingText}
                  onChange={(v) => update({ plannedBackingText: v })}
                  decimals={dep.collateralDecimals}
                  unit={dep.collateralSymbol}
                  help={tier ? `At least ${formatFixed(tier.minMakerBacking, dep.collateralDecimals, 0)} ${dep.collateralSymbol}. A maker commits this from the maker desk; it is checked again onchain before activation.` : undefined}
                />
                <AmountField
                  label={copy.preflight.creatorBond}
                  value={draft.bondText}
                  onChange={(v) => update({ bondText: v })}
                  decimals={dep.collateralDecimals}
                  unit={dep.collateralSymbol}
                  help={tier ? `At least ${formatFixed(tier.minBond, dep.collateralDecimals, 0)} ${dep.collateralSymbol}. You post it at creation; it covers losses after insurance and stays locked while the market carries positions.` : undefined}
                />
              </section>
            </>
          ) : (
            <p className="notice">Leverage stays off. You can create the spot market now; adding perps later needs the same checks.</p>
          )}

          <div className={styles.actions}>
            <Link href="/app/create/liquidity" className="btn">
              Back
            </Link>
            <button type="button" className="btn btn-primary btn-lg" disabled={!canContinue} onClick={() => router.push("/app/create/preflight")}>
              {copy.preflight.check}
            </button>
          </div>
        </div>
        <aside className={`panel panel-pad ${styles.summary}`} aria-label="Selected limits">
          <h2 className="t-label" style={{ margin: "0 0 8px" }}>
            What decides activation
          </h2>
          <p className="t-small muted" style={{ margin: 0 }}>
            The feed must be approved for this exact token and updating within its heartbeat. Maker backing must be committed in the vault, not promised. The bond must be posted. MarketPreflight rechecks all of it in the activation transaction.
          </p>
        </aside>
      </div>
    </div>
  );
}
