"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { copy } from "@rooq/ui";
import { CHAIN, DEPLOYMENT } from "@/lib/env";
import { useTokenRead } from "@/lib/create-data";
import { Address, AssetEmblem, TestTag } from "@/components/primitives";
import { Warning } from "@/components/icons";
import { useCreateDraft } from "../create-store";
import { CreateSteps } from "../steps";
import styles from "../create.module.css";

/** C02. The asset is identified by chain and address; its name and symbol are shown but not trusted. */
export function AssetStep({ initialAddress }: { initialAddress: string }) {
  const router = useRouter();
  const { draft, update } = useCreateDraft();
  const [text, setText] = useState(initialAddress || draft.token?.address || "");
  const [seenInitial, setSeenInitial] = useState(initialAddress);
  if (initialAddress !== seenInitial) {
    setSeenInitial(initialAddress);
    if (initialAddress) setText(initialAddress);
  }
  const read = useTokenRead(text);
  const t = read.data;

  const problem = !t
    ? null
    : !t.hasCode
      ? "This address has no contract code on this network."
      : t.isCollateral
        ? "This is the quote asset itself. Choose a different token."
        : t.decimals === null || t.symbol === null
          ? "This contract does not answer standard ERC-20 reads (symbol, name, decimals)."
          : t.decimals > 18
            ? "Tokens with more than 18 decimals can't be traded here yet."
            : null;
  const canContinue = Boolean(t && !problem && !t.existingMarketId && t.symbol && t.name && t.decimals !== null);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <CreateSteps current={0} />
        <h1 className="t-page">{copy.preflight.asset}</h1>
        <p className="muted" style={{ margin: 0 }}>
          Paste the token&apos;s contract address on {CHAIN.name}. Tickers are not unique, so the address is the identity.
        </p>
      </header>
      <div className={styles.layout}>
        <div className={styles.main}>
          <label className="field">
            <span className="field-label">Token address</span>
            <input
              className="input-text num"
              value={text}
              onChange={(e) => setText(e.target.value.trim())}
              placeholder="0x..."
              spellCheck={false}
              autoComplete="off"
              aria-invalid={text !== "" && !/^0x[0-9a-fA-F]{40}$/.test(text)}
            />
            {text !== "" && !/^0x[0-9a-fA-F]{40}$/.test(text) ? <span className="field-error">Enter a 42-character 0x address.</span> : null}
          </label>

          {read.isFetching && !t ? <p className="t-small muted">Reading the contract.</p> : null}
          {read.isError ? (
            <p className="notice" data-tone="warning" role="alert">
              The chain could not be read. Check your connection and try again.
            </p>
          ) : null}

          {t ? (
            <section className="panel panel-pad stack" aria-label="Token found">
              <div className="row" style={{ "--gap": "12px" } as React.CSSProperties}>
                <AssetEmblem logoUrl={t.identity?.logoUrl ?? null} assetClass={t.identity?.assetClass ?? "crypto"} size={40} label={t.symbol ?? "Token"} />
                <div style={{ display: "grid" }}>
                  <strong>{t.symbol ?? "Unknown symbol"}</strong>
                  <span className="t-small muted">{t.name ?? "Unknown name"}</span>
                </div>
                {t.identity?.verified ? <span className="tag" data-tone="verified">Verified issuer asset</span> : null}
                {t.identity?.isTestFixture ? <TestTag>Test fixture</TestTag> : null}
              </div>
              <dl className="facts">
                <div>
                  <dt>Network</dt>
                  <dd>
                    {CHAIN.name}
                    <span className="sub">Chain ID {CHAIN.id}</span>
                  </dd>
                </div>
                <div>
                  <dt>Contract</dt>
                  <dd className={styles.mono}>{t.address}</dd>
                </div>
                <div>
                  <dt>Decimals</dt>
                  <dd>{t.decimals ?? "—"}</dd>
                </div>
                <div>
                  <dt>{copy.preflight.quoteAsset}</dt>
                  <dd>{DEPLOYMENT ? `${DEPLOYMENT.collateralSymbol}` : "—"}</dd>
                </div>
              </dl>
              <Address value={t.address} />
              {t.identity?.verification ? (
                <p className="t-small muted" style={{ margin: 0 }}>
                  {t.identity.verification.method}.{" "}
                  <a href={t.identity.verification.sourceUrl} target="_blank" rel="noreferrer">
                    Source
                  </a>
                </p>
              ) : (
                <p className="t-small muted" style={{ margin: 0 }}>
                  This token is not in Rooq&apos;s verified asset list. Its name and symbol come from the contract and may imitate another asset.
                </p>
              )}
              {t.impostor ? (
                <p className="notice" data-tone="negative" role="alert">
                  <Warning size={16} /> Known impostor: {t.impostor}
                </p>
              ) : null}
              {problem ? (
                <p className="notice" data-tone="warning" role="alert">
                  {problem}
                </p>
              ) : null}
              {t.existingMarketId ? (
                <p className="notice">
                  A market for this token already exists.{" "}
                  <Link href={`/app/trade/${t.existingMarketId}?mode=spot`}>Open it</Link>
                </p>
              ) : null}
              <p className="t-small faint" style={{ margin: 0 }}>
                Transfer fees, rebasing and callbacks can&apos;t be detected by reading the contract. Rooq pools check every deposit by balance change and reject tokens that deliver less than sent.
              </p>
            </section>
          ) : null}

          <div className={styles.actions}>
            <Link href="/app/create" className="btn">
              Back
            </Link>
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={!canContinue}
              onClick={() => {
                if (!t || !t.symbol || !t.name || t.decimals === null) return;
                update({ token: { address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals }, feedId: null, createdMarketId: null });
                router.push("/app/create/liquidity");
              }}
            >
              Continue
            </button>
          </div>
        </div>
        <aside className={`panel panel-pad ${styles.summary}`} aria-label="Why the address matters">
          <h2 className="t-label" style={{ margin: "0 0 8px" }}>
            Identity rules
          </h2>
          <p className="t-small muted" style={{ margin: 0 }}>
            Rooq treats an asset as its chain and contract address. A token that copies a ticker never borrows a verified name or logo. Stock Tokens are matched only to the issuer&apos;s own deployments.
          </p>
        </aside>
      </div>
    </div>
  );
}
