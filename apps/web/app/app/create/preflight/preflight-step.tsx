"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { PREFLIGHT_CHECKS, PREFLIGHT_VERDICT, marketPreflightAbi, marketRegistryAbi, parseDecimal } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { DEPLOYMENT } from "@/lib/env";
import { Check, Warning } from "@/components/icons";
import { useCreateDraft } from "../create-store";
import { CreateSteps } from "../steps";
import { missingReason } from "../preflight-reasons";
import styles from "../create.module.css";

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const SPOT_BITS = (1n << 0n) | (1n << 1n);

/**
 * C05. Every row is a live onchain read from MarketPreflight.previewAsset. It reserves nothing:
 * activatePerps rechecks the same conditions in its own transaction.
 */
/** Where each failed check can actually be repaired in the flow. */
function repairHref(key: string): Route | null {
  if (key === "baseContract" || key === "decimals") return "/app/create/asset";
  if (key === "spotFunded") return "/app/create/liquidity";
  if (key === "feedApproved" || key === "riskBounds" || key === "makerBacking" || key === "bond") return "/app/create/leverage";
  return null;
}

export function PreflightStep() {
  const router = useRouter();
  const client = usePublicClient();
  const { draft } = useCreateDraft();
  const token = draft.token;
  const dep = DEPLOYMENT;
  const seedQuote = dep ? parseDecimal(draft.seedQuoteText, dep.collateralDecimals) : null;
  const seedBase = token ? parseDecimal(draft.seedBaseText, token.decimals) : null;
  const backing = dep ? parseDecimal(draft.plannedBackingText, dep.collateralDecimals) : null;
  const bond = dep ? parseDecimal(draft.bondText, dep.collateralDecimals) : null;

  const preview = useQuery({
    queryKey: ["create-preflight", token?.address, draft.feedId, draft.tierId, backing?.toString(), bond?.toString(), seedQuote?.toString(), draft.perps],
    enabled: Boolean(client && dep && token),
    queryFn: async () => {
      if (!client || !dep || !token) return null;
      const [result, quoteApproved, block] = await Promise.all([
        client.readContract({
          address: dep.marketPreflight,
          abi: marketPreflightAbi,
          functionName: "previewAsset",
          args: [
            {
              base: token.address,
              quote: dep.collateral,
              feedId: draft.perps && draft.feedId ? draft.feedId : ZERO32,
              tierId: draft.tierId,
              plannedBacking: draft.perps ? (backing ?? 0n) : 0n,
              plannedBond: draft.perps ? (bond ?? 0n) : 0n,
              plannedSpotQuote: seedQuote ?? 0n,
            },
          ],
        }),
        client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "isQuoteAsset", args: [dep.collateral] }),
        client.getBlockNumber(),
      ]);
      return { mask: result[0], verdict: PREFLIGHT_VERDICT[result[1]] ?? "BLOCKED", quoteApproved, block };
    },
  });

  if (!token || !dep) {
    return (
      <div className={styles.page}>
        <CreateSteps current={3} />
        <p className="empty">
          Choose an asset first.
          <Link className="btn" href="/app/create/asset">
            Choose asset
          </Link>
        </p>
      </div>
    );
  }

  const data = preview.data;
  const spotReady = Boolean(data && (data.mask & SPOT_BITS) === SPOT_BITS && data.quoteApproved && seedBase && seedBase > 0n && seedQuote && seedQuote > 0n);
  const spotKeys: readonly string[] = ["baseContract", "decimals", "collateral", "spotFunded"];
  const failedKeys = data
    ? PREFLIGHT_CHECKS.filter((c) => (data.mask & c.bit) === 0n)
        .map((c) => c.key)
        .filter((k) => draft.perps || spotKeys.includes(k))
    : [];
  const perpHeadline = !draft.perps
    ? "Leverage is off for this launch."
    : !data
      ? "—"
      : data.verdict === "READY"
        ? "Both trading modes can go live."
        : data.verdict === "NEEDS_FEED"
          ? "No reliable price feed is available."
          : data.verdict === "NEEDS_BACKING"
            ? "Perps need more backing."
            : copy.preflight.notReady;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <CreateSteps current={3} />
        <h1 className="t-page">{copy.preflight.check}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {`Each line below is read from the MarketPreflight contract at block ${data ? data.block.toString() : "—"}. Nothing is reserved and no gas is spent.`}
        </p>
      </header>
      <div className={styles.layout}>
        <div className={styles.main}>
          {preview.isError ? (
            <p className="notice" data-tone="warning" role="alert">
              Requirements are unavailable because the chain could not be read.{" "}
              <button type="button" className="btn-link" onClick={() => void preview.refetch()}>
                {copy.preflight.retry}
              </button>
            </p>
          ) : null}
          <div className={styles.cards} style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            <section className={styles.verdict} data-tone={spotReady ? "ready" : "warn"} aria-live="polite">
              <span className="t-label muted">{copy.spot.tab}</span>
              <strong>{data ? (spotReady ? "Spot is ready." : "Spot can't launch yet.") : "—"}</strong>
              {data && !spotReady ? <span className="t-small muted">Check the token and add liquidity on both sides.</span> : null}
            </section>
            <section className={styles.verdict} data-tone={draft.perps && data?.verdict === "READY" ? "ready" : "warn"} aria-live="polite">
              <span className="t-label muted">{copy.perps.tab}</span>
              <strong>{perpHeadline}</strong>
              {draft.perps && data && data.verdict !== "READY" ? <span className="t-small muted">{copy.preflight.notReady}</span> : null}
            </section>
          </div>

          <section className="panel panel-pad" aria-label="Requirement checks">
            <ul className={styles.checks}>
              {PREFLIGHT_CHECKS.map((c) => {
                const passed = data ? (data.mask & c.bit) !== 0n : null;
                return (
                  <li key={c.key} className={styles.check} data-passed={passed === null ? undefined : passed}>
                    {passed ? <Check size={18} /> : passed === false ? <Warning size={18} /> : <span aria-hidden />}
                    <span className={styles.checkText}>
                      <span>{c.label}</span>
                      {passed === false ? <span className="t-small muted">{missingReason(c.key, dep.collateralSymbol)}</span> : null}
                    </span>
                    <span className="row" style={{ "--gap": "8px" } as React.CSSProperties}>
                      {passed === false && repairHref(c.key) ? (
                        <Link className={styles.fix} href={repairHref(c.key)!}>
                          Fix
                        </Link>
                      ) : null}
                      <span className={passed ? "t-small pos" : passed === false ? "t-small warn" : "t-small faint"}>{passed === null ? "—" : passed ? "Ready" : "Missing"}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          <p className="t-small muted" style={{ margin: 0 }}>
            {copy.preflight.noGuarantee} Preflight is not an investment recommendation or a fraud check.
          </p>

          <div className={styles.actions}>
            <Link href={draft.perps ? "/app/create/leverage" : "/app/create/liquidity"} className="btn">
              {failedKeys.length > 0 ? "Fix issue" : "Back"}
            </Link>
            <span className="row">
              <button type="button" className="btn" onClick={() => void preview.refetch()} disabled={preview.isFetching}>
                {copy.preflight.retry}
              </button>
              <button type="button" className="btn btn-primary btn-lg" disabled={!spotReady} onClick={() => router.push("/app/create/review")}>
                {draft.perps && draft.feedId ? copy.preflight.review : copy.preflight.spotOnly}
              </button>
            </span>
          </div>
        </div>
        <aside className={`panel panel-pad ${styles.summary}`} aria-label="Draft summary">
          <h2 className="t-label" style={{ margin: "0 0 8px" }}>
            Your market
          </h2>
          <dl className="facts">
            <div>
              <dt>{copy.preflight.asset}</dt>
              <dd>{token.symbol}</dd>
            </div>
            <div>
              <dt>{copy.preflight.quoteAsset}</dt>
              <dd>{dep.collateralSymbol}</dd>
            </div>
            <div>
              <dt>{copy.preflight.perpLaunch}</dt>
              <dd>{draft.perps ? "Requested" : "No"}</dd>
            </div>
            <div>
              <dt>Verdict</dt>
              <dd>{data ? data.verdict.replace("_", " ").toLowerCase() : "—"}</dd>
            </div>
          </dl>
          <p className="t-small faint" style={{ margin: "8px 0 0" }}>
            This preview reserves nothing. Activation rechecks every condition onchain.
          </p>
        </aside>
      </div>
    </div>
  );
}
