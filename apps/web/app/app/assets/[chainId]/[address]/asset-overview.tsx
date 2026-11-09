"use client";

import Link from "next/link";
import { isAddress, getAddress } from "viem";
import { formatAge, formatBps } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { CHAIN } from "@/lib/env";
import { useMarketSnapshots } from "@/lib/chain-data";
import { useTokenRead } from "@/lib/create-data";
import { useChainNow } from "@/lib/use-now";
import { fundingPerHour, makerCapacity, maxLeverage, oiUsage, price } from "@/lib/display";
import { Address, AssetEmblem, PerpStatusPill, SpotStatusPill, TestTag, StateBlock } from "@/components/primitives";
import { Warning } from "@/components/icons";
import styles from "../../assets.module.css";

const STOCK_TOKEN_DISCLOSURE = "Stock Tokens provide price exposure. They do not give you shares or shareholder rights.";

/** M02. Identity first: chain and address, its verified source, then what you can do with it. */
export function AssetOverview({ chainId, address }: { chainId: number; address: string }) {
  const { data: markets, isLoading } = useMarketSnapshots();
  const token = useTokenRead(isAddress(address) ? address : "");
  const chainNow = useChainNow();

  if (!isAddress(address)) {
    return (
      <div className={styles.page}>
        <StateBlock kind="empty" title="This is not a valid contract address" actions={<Link className="btn" href="/app/markets">{copy.portfolio.openMarket}</Link>} />
      </div>
    );
  }
  if (chainId !== CHAIN.id) {
    return (
      <div className={styles.page}>
        <p className="notice" data-tone="warning" role="alert">
          {`This link is for chain ${chainId}. Rooq here runs on ${CHAIN.name} (chain ${CHAIN.id}). The same address on another chain can be a different token, so nothing is shown.`}
        </p>
      </div>
    );
  }

  const addr = getAddress(address);
  const m = markets?.find((x) => x.base.address.toLowerCase() === addr.toLowerCase());
  const identity = m?.base ?? token.data?.identity ?? null;
  const isStock = identity?.assetClass === "stock-token";
  const perpsOpen = Boolean(m && m.hasPerps && m.effectivePerpStatus === "ACTIVE");
  const perpsReason = !m
    ? null
    : !m.hasPerps
      ? "No approved price feed exists for this asset, so leverage is not available."
      : m.perpStatus === "REGISTERED"
        ? copy.preflight.capacityMissing
        : m.perpStatus === "ACTIVE" && !m.markFresh
          ? copy.errors.oracleStale
          : m.perpStatus !== "ACTIVE"
            ? copy.errors.paused
            : null;
  const markAge = m?.markUpdatedAt !== null && m?.markUpdatedAt !== undefined && chainNow !== null ? chainNow - m.markUpdatedAt : null;

  const source = identity?.verification ? (
    <a href={identity.verification.sourceUrl} target="_blank" rel="noreferrer">
      Issuer record
    </a>
  ) : identity?.isTestFixture ? (
    "Rooq test fixture, no value"
  ) : (
    "Not verified"
  );

  return (
    <div className={styles.page}>
      <section className={styles.identity} aria-label="Asset identity">
        <div className={styles.identityHead}>
          <AssetEmblem logoUrl={identity?.logoUrl ?? null} assetClass={identity?.assetClass ?? "crypto"} size={40} label={identity?.symbol ?? "Asset"} />
          <h1 className={styles.symbol}>{identity?.symbol ?? (token.isLoading || isLoading ? "Reading" : "Unknown asset")}</h1>
          {identity?.verified ? <span className="tag" data-tone="verified">{isStock ? "Stock Token" : "Verified asset"}</span> : null}
          {identity?.isTestFixture ? <TestTag>Test fixture</TestTag> : null}
          <span className={styles.name}>{identity?.name ?? ""}</span>
        </div>
        <div className={styles.addressLine}>
          <span className={styles.mono}>{addr}</span>
          <Address value={addr} hideText />
        </div>
        <dl className={styles.identityFacts}>
          <div>
            <dt>Network</dt>
            <dd>{`${CHAIN.name}, chain ${CHAIN.id}`}</dd>
          </div>
          <div>
            <dt>Decimals</dt>
            <dd className="num">{identity?.decimals ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{source}</dd>
          </div>
        </dl>
        <p className="t-small muted" style={{ margin: 0 }}>
          {identity?.verification ? `${identity.verification.method}. Checked ${identity.verification.verifiedAt}.` : "The name and symbol come from the contract and are not trusted. Only the address identifies this asset."}
        </p>
        {token.data && !token.data.hasCode ? <p className="notice" data-tone="warning">This address has no contract code on this network.</p> : null}
      </section>

      {identity?.impostorWarning ? (
        <p className="notice" data-tone="negative" role="alert">
          <Warning size={16} /> {`Known impostor: ${identity.impostorWarning}.`}
        </p>
      ) : null}
      {isStock ? <p className="notice">{STOCK_TOKEN_DISCLOSURE}</p> : null}

      <section className={styles.paths} aria-label="What you can do">
        {!m && token.data?.existingMarketId ? (
          <p className="notice" role="note" style={{ margin: 0 }}>
            {`A market for this asset exists onchain (ID ${token.data.existingMarketId.slice(0, 10)}\u2026). This app build lists markets from its deployment file, so trading screens show it after the next deployment sync.`}
          </p>
        ) : !m ? (
          <StateBlock kind="empty" title="No market exists for this asset yet" actions={<Link className="btn btn-primary" href={`/app/create/asset?address=${addr}`}>{copy.preflight.title}</Link>} />
        ) : (
          <>
            <div className={styles.path}>
              <div className={styles.pathHead}>
                <h2 className={styles.pathTitle}>Own it</h2>
                <SpotStatusPill status={m.spotStatus} funded={m.reserveBase > 0n} />
              </div>
              <p className={styles.pathPrice}>
                {price(m.poolPrice)}
                <span>Pool price</span>
              </p>
              <dl className="facts">
                <div>
                  <dt>{copy.spot.swapFee}</dt>
                  <dd>{formatBps(m.poolFeeBps)}</dd>
                </div>
                <div>
                  <dt>Liquidation</dt>
                  <dd className="text">None</dd>
                </div>
              </dl>
              {m.spotStatus === "ACTIVE" && m.reserveBase > 0n ? (
                <Link className="btn btn-primary btn-lg btn-block" href={`/app/trade/${m.deployed.key}?mode=spot`}>
                  Buy token
                </Link>
              ) : (
                <button type="button" className="btn btn-lg btn-block" disabled>
                  {copy.spot.emptyPool}
                </button>
              )}
            </div>
            <div className={styles.path}>
              <div className={styles.pathHead}>
                <h2 className={styles.pathTitle}>Trade its price</h2>
                {m.hasPerps ? <PerpStatusPill status={m.perpStatus} fresh={m.markFresh} /> : <span className="tag">Spot only</span>}
              </div>
              <p className={styles.pathPrice}>
                {m.hasPerps ? price(m.mark) : "Unavailable"}
                <span>{m.hasPerps ? (markAge === null ? copy.perps.markPrice : `Mark, TEST relay, updated ${formatAge(markAge)}`) : "No approved price feed"}</span>
              </p>
              {m.hasPerps ? (
                <dl className="facts">
                  <div>
                    <dt>{copy.perps.maxLev}</dt>
                    <dd>{maxLeverage(m)}</dd>
                  </div>
                  <div>
                    <dt>{copy.perps.funding} (1h)</dt>
                    <dd>{fundingPerHour(m.fundingRatePerSecondWad)}</dd>
                  </div>
                  <div>
                    <dt>Open interest / cap</dt>
                    <dd>{oiUsage(m)}</dd>
                  </div>
                  <div>
                    <dt>Maker backing</dt>
                    <dd>{makerCapacity(m)}</dd>
                  </div>
                </dl>
              ) : null}
              {perpsOpen ? (
                <Link className="btn btn-lg btn-block" href={`/app/trade/${m.deployed.key}?mode=perps`}>
                  Trade with leverage
                </Link>
              ) : (
                <button type="button" className="btn btn-lg btn-block" disabled aria-describedby={perpsReason ? "perps-reason" : undefined}>
                  Leverage not available
                </button>
              )}
              {!perpsOpen && perpsReason ? (
                <p id="perps-reason" className="btn-reason">
                  {perpsReason}
                </p>
              ) : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
