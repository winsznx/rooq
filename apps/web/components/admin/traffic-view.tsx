"use client";

import type { AdminTraffic } from "@rooq/private-sdk/admin";
import { useAdminRange, useAdminTraffic } from "@/lib/admin/hooks";
import styles from "@/app/admin/admin.module.css";
import { BreakdownTable } from "./breakdown-table";
import { ChartSkeleton } from "./chart-skeleton";
import { count } from "./format";
import { Kpi, KpiStrip } from "./kpi";
import { AdminPageHead } from "./page-head";
import { Loaded } from "./query-state";
import { RANGE_LABEL } from "./range-label";
import { TimeChart } from "./time-chart";

const DEVICE_LABEL: Record<string, string> = { mobile: "Mobile", tablet: "Tablet", desktop: "Desktop" };
const SITE_LABEL: Record<string, string> = { web: "rooq.trade", docs: "Docs" };

function TrafficBody({ data }: { data: AdminTraffic }): React.JSX.Element {
  const views = data.views.reduce((acc, p) => acc + p.v, 0);
  const visits = data.visits.reduce((acc, p) => acc + p.v, 0);
  return (
    <>
      <KpiStrip label="Traffic totals">
        <Kpi label="Page views" value={count(views)} sub="Web and docs" trend={data.views} />
        <Kpi label="Daily visits" value={count(visits)} sub="First view per browser per day" trend={data.visits} />
        <Kpi label="Views per visit" value={visits > 0 ? (views / visits).toFixed(1) : "0"} sub="Across the range" />
      </KpiStrip>
      <TimeChart
        title="Views and visits"
        bucket={data.bucket}
        series={[
          { id: "views", label: "Views", tone: "faint", kind: "bar", points: data.views },
          { id: "visits", label: "Visits", tone: "accent", kind: "bar", points: data.visits },
        ]}
      />
      <div className={styles.split}>
        <BreakdownTable title="Top pages" keyLabel="Route" rows={data.routes} />
        <BreakdownTable title="Referrers" keyLabel="Site" rows={data.referrers} />
        <BreakdownTable title="Devices" keyLabel="Device" rows={data.devices} describe={(k) => DEVICE_LABEL[k] ?? k} />
        <BreakdownTable title="Sites" keyLabel="Site" rows={data.sites} describe={(k) => SITE_LABEL[k] ?? k} />
      </div>
    </>
  );
}

export function TrafficView(): React.JSX.Element {
  const range = useAdminRange();
  const traffic = useAdminTraffic(range);
  return (
    <>
      <AdminPageHead
        title="Traffic"
        lede={`${RANGE_LABEL[range]}. Counted without cookies, IP addresses or user agents. Pages are reported as route patterns, and browsers that send Do Not Track or Global Privacy Control aren't counted.`}
      />
      <Loaded query={traffic} fallback={<ChartSkeleton />}>
        {(data) => <TrafficBody data={data} />}
      </Loaded>
    </>
  );
}
