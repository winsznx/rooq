"use client";

import { useId, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { formatAge } from "@rooq/sdk";
import type { AdminFees, AdminKinds, AdminMoney, AdminPeople, AdminRange, AdminVault } from "@rooq/private-sdk/admin";
import { StateBlock } from "@/components/primitives";
import type { AdminApiError } from "@/lib/admin/hooks";
import { useNow } from "@/lib/use-now";
import styles from "@/app/admin/admin.module.css";
import { ChartSkeleton } from "./chart-skeleton";
import { USD_FORMAT } from "./chart-formats";
import { Donut, DONUT_TONES } from "./donut";
import { count, eth, sharePct, signedPct, usd } from "./format";
import { Loaded, PanelSkeleton, QueryError } from "./query-state";
import { splitPct, topKinds, vaultSlices } from "./slices";
import { TimeChart, type ChartTone } from "./time-chart";

/** Kinds beyond this many fold into "Other", so the stack keeps one colour per layer. */
const KIND_LAYERS = 3;
const KIND_TONES: readonly ChartTone[] = ["accent", "ink", "muted", "faint"];
/** The ring has four tones, so the three largest holdings plus "Other". */
const VAULT_SLICES = 3;

const PRIOR_WINDOW: Record<AdminRange, string | null> = {
  "24h": "the 24 hours before",
  "7d": "the 7 days before",
  "30d": "the 30 days before",
  all: null,
};

/** A titled panel whose body follows one query: skeleton while loading, a state block on error, the data otherwise. */
export function SlicePanel<T>({
  title,
  query,
  meta,
  skeletonLines,
  children,
}: {
  title: string;
  query: UseQueryResult<T, AdminApiError>;
  meta?: (data: T) => ReactNode;
  skeletonLines?: number;
  children: (data: T) => ReactNode;
}): React.JSX.Element {
  const id = useId();
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel-head">
        <h2 id={id} className={styles.panelTitle}>
          {title}
        </h2>
        {meta && query.data !== undefined ? <span className={styles.panelMeta}>{meta(query.data)}</span> : null}
      </div>
      <Loaded query={query} fallback={<PanelSkeleton label={`Loading ${title.toLowerCase()}`} lines={skeletonLines} />}>
        {children}
      </Loaded>
    </section>
  );
}

export function Figure({ label, value, sub }: { label: string; value: string; sub?: ReactNode }): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {sub ? <span className={styles.figureSub}>{sub}</span> : null}
      </dd>
    </div>
  );
}

export interface SplitSide {
  readonly label: string;
  readonly value: number;
  readonly detail: string;
  readonly tone: "accent" | "muted";
}

/** Two shares of one whole. Each side is named in text next to its figure, so colour is never the only cue. */
export function SplitBar({ label, left, right }: { label: string; left: SplitSide; right: SplitSide }): React.JSX.Element {
  const [l, r] = splitPct(left.value, right.value);
  return (
    <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
      <div className={styles.splitBar} role="img" aria-label={`${label}: ${left.label} ${l.toFixed(0)}%, ${right.label} ${r.toFixed(0)}%`}>
        {l > 0 ? <span className={styles.splitPart} data-tone={left.tone} style={{ flexGrow: l }} /> : null}
        {r > 0 ? <span className={styles.splitPart} data-tone={right.tone} style={{ flexGrow: r }} /> : null}
      </div>
      <div className={styles.splitLegend} aria-hidden>
        <span className={styles.legendItem}>
          <span className={styles.swatch} data-tone={left.tone} />
          {`${left.label} ${left.detail}`}
        </span>
        <span className={styles.legendItem}>
          {`${right.label} ${right.detail}`}
          <span className={styles.swatch} data-tone={right.tone} />
        </span>
      </div>
    </div>
  );
}

function ChangeBadge({ pct, range }: { pct: number | null; range: AdminRange }): React.JSX.Element | null {
  const prior = PRIOR_WINDOW[range];
  if (prior === null) return null;
  if (pct === null) return <span className={styles.panelMeta}>No earlier window to compare</span>;
  const tone = pct > 0 ? "positive" : pct < 0 ? "negative" : "neutral";
  return (
    <span className="pill" data-tone={tone}>
      {`${signedPct(pct)} vs ${prior}`}
    </span>
  );
}

function MoneyFigures({ money }: { money: AdminMoney }): React.JSX.Element {
  const { totals } = money;
  return (
    <div className={styles.heroFigures}>
      <div className={styles.heroHead}>
        <h2 className={styles.panelTitle}>Money moved</h2>
        <ChangeBadge pct={totals.changePct} range={money.range} />
      </div>
      <div>
        <span className={styles.heroValue}>{usd(totals.allTimeUsd, { whole: true })}</span>
        <span className={styles.heroCaption}>Shielded and unshielded since deployment</span>
      </div>
      <dl className={styles.figures}>
        <Figure label="Last 24 hours" value={usd(totals.last24hUsd)} />
        <Figure label="Last 7 days" value={usd(totals.last7dUsd)} />
        <Figure label="In, this range" value={usd(totals.inUsd)} sub="Shielded" />
        <Figure label="Out, this range" value={usd(totals.outUsd)} sub="Unshielded" />
      </dl>
      {money.unpriced > 0 ? <p className={styles.note}>{`${count(money.unpriced)} ${money.unpriced === 1 ? "event" : "events"} had no oracle price yet and aren't counted in dollars.`}</p> : null}
    </div>
  );
}

/** The loud figure on the overview: dollars that crossed the custody boundary, with the in and out series beside it. */
export function MoneyHero({ query }: { query: UseQueryResult<AdminMoney, AdminApiError> }): React.JSX.Element {
  const money = query.data;
  if (money === undefined) {
    return (
      <section className={styles.hero} aria-label="Money moved">
        {query.isError ? <QueryError error={query.error} onRetry={() => void query.refetch()} /> : <PanelSkeleton label="Loading money moved" lines={4} />}
        {query.isError ? null : <ChartSkeleton label="Loading money chart" />}
      </section>
    );
  }
  return (
    <section className={styles.hero} aria-label="Money moved">
      <MoneyFigures money={money} />
      <div className={styles.heroChart}>
        <TimeChart
          title="Money in and out, in dollars"
          bucket={money.bucket}
          format={USD_FORMAT}
          plain
          series={[
            { id: "in", label: "In", tone: "accent", kind: "bar", points: money.series.in },
            { id: "out", label: "Out", tone: "muted", kind: "bar", points: money.series.out },
          ]}
        />
      </div>
    </section>
  );
}

function VaultBody({ vault }: { vault: AdminVault }): React.JSX.Element {
  const slices = vaultSlices(vault, VAULT_SLICES);
  const unpriced = vault.assets.filter((a) => a.usd === null).length;
  if (vault.assets.length === 0) return <StateBlock kind="empty" title="The vault holds nothing yet" body="Balances show here once someone shields." />;
  return (
    <div className={`${styles.panelBody} stack`} style={{ "--gap": "12px" } as React.CSSProperties}>
      <div className={styles.donutLayout}>
        <Donut
          slices={slices}
          center={
            <>
              <span className={styles.donutValue}>{usd(vault.totalUsd)}</span>
              <span className={styles.donutLabel}>held now</span>
            </>
          }
        />
        <ul className={styles.shares} aria-label="Holdings by asset">
          {slices.map((s, i) => (
            <li key={s.id}>
              <span className={styles.swatch} data-tone={DONUT_TONES[Math.min(i, DONUT_TONES.length - 1)]} aria-hidden />
              <span className={styles.shareName}>{s.label}</span>
              <span className={styles.shareValue}>{usd(s.usd)}</span>
              <span className={styles.sharePct}>{sharePct(s.pct)}</span>
            </li>
          ))}
        </ul>
      </div>
      {unpriced > 0 ? (
        <p className={styles.note}>{`${count(unpriced)} ${unpriced === 1 ? "asset has" : "assets have"} no oracle price yet and ${unpriced === 1 ? "is" : "are"} left out of the total.`}</p>
      ) : null}
    </div>
  );
}

export function VaultPanel({ query }: { query: UseQueryResult<AdminVault, AdminApiError> }): React.JSX.Element {
  const now = useNow();
  return (
    <SlicePanel title="In the vault" query={query} meta={(v) => `Read ${formatAge(now - v.asOf)}`} skeletonLines={4}>
      {(vault) => <VaultBody vault={vault} />}
    </SlicePanel>
  );
}

export function FeesPanel({ query }: { query: UseQueryResult<AdminFees, AdminApiError> }): React.JSX.Element {
  return (
    <SlicePanel title="Fees" query={query}>
      {(fees) => (
        <>
          <div className={styles.panelBody}>
            <dl className={styles.figures}>
              <Figure label="Relayer fees earned" value={usd(fees.relayerFeesUsd)} sub="Taken from unshields" />
              <Figure label="Relayer gas spent" value={eth(fees.relayerGasWei, 5)} sub="What those unshields cost to send" />
            </dl>
          </div>
          <TimeChart
            title="Relayer fees in dollars"
            bucket={fees.bucket}
            format={USD_FORMAT}
            plain
            series={[{ id: "fees", label: "Fees", tone: "accent", kind: "bar", points: fees.relayerFeesSeries }]}
          />
        </>
      )}
    </SlicePanel>
  );
}

export function PeoplePanel({ query }: { query: UseQueryResult<AdminPeople, AdminApiError> }): React.JSX.Element {
  return (
    <SlicePanel title="People" query={query}>
      {(people) => (
        <>
          <div className={`${styles.panelBody} stack`} style={{ "--gap": "14px" } as React.CSSProperties}>
            <dl className={styles.figures}>
              <Figure label="Active public wallets" value={count(people.activeInRange)} sub="In range" />
              <Figure label="Still shielded" value={count(people.stillShielded)} sub="Shielded, never unshielded" />
            </dl>
            <SplitBar
              label="Active wallets"
              left={{ label: "New", value: people.newInRange, detail: count(people.newInRange), tone: "accent" }}
              right={{ label: "Returning", value: people.returningInRange, detail: count(people.returningInRange), tone: "muted" }}
            />
          </div>
          <TimeChart title="Active public wallets per bucket" bucket={people.bucket} plain series={[{ id: "active", label: "Active", tone: "ink", kind: "bar", points: people.active }]} />
        </>
      )}
    </SlicePanel>
  );
}

export function KindsPanel({ query }: { query: UseQueryResult<AdminKinds, AdminApiError> }): React.JSX.Element {
  return (
    <SlicePanel title="Transactions by kind" query={query}>
      {(kinds) => (
        <TimeChart
          title="User transactions by kind"
          bucket={kinds.bucket}
          stacked
          plain
          series={topKinds(kinds.kinds, KIND_LAYERS).map((k, i) => ({ id: k.id, label: k.label, tone: KIND_TONES[Math.min(i, KIND_TONES.length - 1)]!, kind: "bar" as const, points: k.points }))}
        />
      )}
    </SlicePanel>
  );
}
