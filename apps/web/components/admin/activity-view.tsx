"use client";

import type { AdminActionRow, AdminActions, TxCategory } from "@rooq/private-sdk/admin";
import { StateBlock } from "@/components/primitives";
import { bucketFor, useAdminActions, useAdminRange } from "@/lib/admin/hooks";
import styles from "@/app/admin/admin.module.css";
import { ChartSkeleton } from "./chart-skeleton";
import { CATEGORY_LABEL, actionLabel, count } from "./format";
import { Kpi, KpiStrip } from "./kpi";
import { AdminPageHead } from "./page-head";
import { Loaded, TableSkeleton } from "./query-state";
import { RANGE_LABEL } from "./range-label";
import { TimeChart } from "./time-chart";

const CATEGORIES: readonly TxCategory[] = ["user", "maintenance", "oracle"];

function sum(rows: readonly AdminActionRow[], pick: (r: AdminActionRow) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0);
}

function ActionsTable({ rows }: { rows: readonly AdminActionRow[] }): React.JSX.Element {
  if (rows.length === 0) return <StateBlock kind="empty" title="No transactions in this range" body="Nothing indexed matches this window yet." />;
  return (
    <div className="panel table-scroll">
      <table className="table">
        <caption className="sr-only">Transactions by action, grouped by category</caption>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col" className="n">
              Transactions
            </th>
          </tr>
        </thead>
        {CATEGORIES.map((category) => {
          const group = rows.filter((r) => r.category === category).sort((a, b) => b.count - a.count);
          if (group.length === 0) return null;
          return (
            <tbody key={category}>
              <tr>
                <th scope="rowgroup" colSpan={2} className="t-small muted" style={{ height: 36, background: "var(--rq-surface-raised)" }}>
                  {`${CATEGORY_LABEL[category]}, ${count(sum(group, (r) => r.count))} transactions`}
                </th>
              </tr>
              {group.map((r) => (
                <tr key={`${category}:${r.action}`}>
                  <th scope="row" style={{ fontWeight: 400 }}>
                    {actionLabel(r.action)}
                  </th>
                  <td className="n">{count(r.count)}</td>
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
      <p className={styles.tableNote}>
        Split by function called, not by sender: the relayer, coordinator and risk workers send most user actions on users&apos; behalf. Only transactions that emitted a
        protocol event are indexed, so reverts don&apos;t appear here. Look for them under unindexed transactions on Operators and the relayer&apos;s reverted jobs on Services.
      </p>
    </div>
  );
}

function ActivityBody({ data }: { data: AdminActions }): React.JSX.Element {
  const bucket = data.bucket;
  return (
    <>
      <KpiStrip label="Transaction totals">
        {CATEGORIES.map((c) => {
          const rows = data.rows.filter((r) => r.category === c);
          return <Kpi key={c} label={CATEGORY_LABEL[c]} value={count(sum(rows, (r) => r.count))} sub={`${count(rows.length)} ${rows.length === 1 ? "action" : "actions"}`} trend={data.series[c]} />;
        })}
      </KpiStrip>
      <div className={styles.split}>
        <TimeChart
          title="User and maintenance transactions"
          bucket={bucket}
          stacked
          series={[
            { id: "user", label: CATEGORY_LABEL.user, tone: "accent", kind: "bar", points: data.series.user },
            { id: "maintenance", label: CATEGORY_LABEL.maintenance, tone: "muted", kind: "bar", points: data.series.maintenance },
          ]}
        />
        <TimeChart title="Oracle price writes" bucket={bucket} series={[{ id: "oracle", label: CATEGORY_LABEL.oracle, tone: "faint", kind: "bar", points: data.series.oracle }]} />
      </div>
      <ActionsTable rows={data.rows} />
    </>
  );
}

export function ActivityView(): React.JSX.Element {
  const range = useAdminRange();
  const actions = useAdminActions(range);
  return (
    <>
      <AdminPageHead
        title="Activity"
        lede={`${RANGE_LABEL[range]}, in ${bucketFor(range) === "hour" ? "hourly" : "daily"} buckets. Oracle writes get their own chart because their volume would flatten everything else.`}
      />
      <Loaded
        query={actions}
        fallback={
          <>
            <ChartSkeleton />
            <TableSkeleton label="Loading transactions" rows={6} />
          </>
        }
      >
        {(data) => <ActivityBody data={data} />}
      </Loaded>
    </>
  );
}
