"use client";

import type { AdminWallets } from "@rooq/private-sdk/admin";
import { StateBlock } from "@/components/primitives";
import { useAdminRange, useAdminWallets } from "@/lib/admin/hooks";
import styles from "@/app/admin/admin.module.css";
import { ChartSkeleton } from "./chart-skeleton";
import { SOURCE_LABEL, count } from "./format";
import { Kpi, KpiStrip } from "./kpi";
import { AdminPageHead } from "./page-head";
import { Loaded } from "./query-state";
import { RANGE_LABEL } from "./range-label";
import { TimeChart } from "./time-chart";

function SourceTable({ data }: { data: AdminWallets }): React.JSX.Element {
  const rows = [...data.bySource].sort((a, b) => b.count - a.count);
  if (rows.length === 0) return <StateBlock kind="empty" title="No public wallets yet" body="A wallet is counted the first time it shields, receives an unshield, creates a market or calls a contract itself." />;
  return (
    <div className="panel table-scroll">
      <table className="table">
        <caption className="sr-only">Public wallets by how they were first seen</caption>
        <thead>
          <tr>
            <th scope="col">First seen</th>
            <th scope="col" className="n">
              Wallets
            </th>
            <th scope="col" className="n">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source}>
              <th scope="row" style={{ fontWeight: 400 }}>
                {SOURCE_LABEL[r.source]}
              </th>
              <td className="n">{count(r.count)}</td>
              <td className="n">{data.total > 0 ? `${((r.count / data.total) * 100).toFixed(0)}%` : "0%"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WalletsBody({ data }: { data: AdminWallets }): React.JSX.Element {
  return (
    <>
      <KpiStrip label="Wallet counts">
        <Kpi label="Public wallets" value={count(data.total)} sub="All time" trend={data.cumulative} />
        <Kpi label="New public wallets" value={count(data.newInRange)} sub="In range" trend={data.newPerBucket} />
      </KpiStrip>
      <div className={styles.split}>
        <TimeChart title="New public wallets" bucket={data.bucket} series={[{ id: "new", label: "New", tone: "accent", kind: "bar", points: data.newPerBucket }]} />
        <TimeChart title="Public wallets over time" bucket={data.bucket} cumulative series={[{ id: "cumulative", label: "Total", tone: "ink", kind: "line", points: data.cumulative }]} />
      </div>
      <SourceTable data={data} />
    </>
  );
}

export function WalletsView(): React.JSX.Element {
  const range = useAdminRange();
  const wallets = useAdminWallets(range);
  return (
    <>
      <AdminPageHead
        title="Wallets"
        lede={`${RANGE_LABEL[range]}. Counts of distinct public wallets that used Rooq, minus our own operator wallets. Private actions can be counted but never tied to a wallet, and this page never lists addresses.`}
      />
      <Loaded query={wallets} fallback={<ChartSkeleton />}>
        {(data) => <WalletsBody data={data} />}
      </Loaded>
    </>
  );
}
