"use client";

import {
  bucketFor,
  useAdminActions,
  useAdminFees,
  useAdminFlows,
  useAdminKinds,
  useAdminMoney,
  useAdminNetwork,
  useAdminOverview,
  useAdminPeople,
  useAdminRange,
  useAdminTraffic,
  useAdminVault,
  useAdminWallets,
} from "@/lib/admin/hooks";
import styles from "@/app/admin/admin.module.css";
import { assetAmounts, count, eth } from "./format";
import { IndexerMeta } from "./indexer-meta";
import { Kpi, KpiStrip } from "./kpi";
import { FeesPanel, KindsPanel, MoneyHero, PeoplePanel, VaultPanel } from "./money-panels";
import { AdminPageHead } from "./page-head";
import { ChartSkeleton } from "./chart-skeleton";
import { Loaded, QueryError } from "./query-state";
import { sumSeries } from "./series";
import { RANGE_LABEL } from "./range-label";
import { TimeChart } from "./time-chart";
import { TokenView } from "./token-view";

/** The bare /admin path is the front page of whichever network the switch points at. */
export function OverviewView(): React.JSX.Element {
  return useAdminNetwork() === "mainnet" ? <TokenView /> : <TestnetOverview />;
}

function TestnetOverview(): React.JSX.Element {
  const range = useAdminRange();
  const bucket = bucketFor(range);
  const overview = useAdminOverview(range);
  const actions = useAdminActions(range);
  const flows = useAdminFlows(range);
  const traffic = useAdminTraffic(range);
  const wallets = useAdminWallets(range);
  const money = useAdminMoney(range);
  const vault = useAdminVault();
  const fees = useAdminFees(range);
  const people = useAdminPeople(range);
  const kinds = useAdminKinds(range);

  const o = overview.data;
  const services = o?.services;
  const servicesDown = services ? services.degraded + services.down : 0;
  const shieldTrend = flows.data ? sumSeries(flows.data.shields.map((s) => s.count)) : undefined;
  const unshieldTrend = flows.data ? sumSeries(flows.data.unshields.map((s) => s.count)) : undefined;

  return (
    <>
      <AdminPageHead title="Overview" meta={o ? <IndexerMeta indexer={o.indexer} /> : null} lede={`${RANGE_LABEL[range]}. Public chain data and cookieless page counts only. Times are UTC.`} />
      <MoneyHero query={money} />
      <div className={styles.split}>
        <VaultPanel query={vault} />
        <FeesPanel query={fees} />
      </div>
      <div className={styles.split}>
        <PeoplePanel query={people} />
        <KindsPanel query={kinds} />
      </div>
      {overview.isError && !o ? (
        <QueryError error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        <KpiStrip label="Key figures" columns={5}>
          <Kpi label="Public wallets" value={o ? count(o.wallets.total) : undefined} sub="All time" trend={wallets.data?.cumulative} />
          <Kpi label="New public wallets" value={o ? count(o.wallets.newInRange) : undefined} sub="In range" trend={wallets.data?.newPerBucket} />
          <Kpi label="Shields" value={o ? count(o.shields.count) : undefined} sub={o ? assetAmounts(o.shields.byAsset) : undefined} trend={shieldTrend} />
          <Kpi label="Unshields" value={o ? count(o.unshields.count) : undefined} sub={o ? assetAmounts(o.unshields.byAsset) : undefined} trend={unshieldTrend} />
          <Kpi label="User transactions" value={o ? count(o.txs.user) : undefined} sub="In range" trend={actions.data?.series.user} />
          <Kpi label="Maintenance transactions" value={o ? count(o.txs.maintenance) : undefined} sub={o ? `${count(o.txs.oracle)} oracle writes` : undefined} trend={actions.data?.series.maintenance} />
          <Kpi label="Operator gas" value={o ? eth(o.operatorGasWei) : undefined} sub="Spent in range" />
          <Kpi label="Page views" value={o ? count(o.traffic.views) : undefined} sub="Web and docs" trend={traffic.data?.views} />
          <Kpi label="Daily visits" value={o ? count(o.traffic.visits) : undefined} sub="First view per browser per day" trend={traffic.data?.visits} />
          <Kpi
            label="Services up"
            value={services ? `${services.ok}/${services.ok + services.degraded + services.down}` : undefined}
            sub={services ? (servicesDown === 0 ? "All operational" : `${services.degraded} degraded, ${services.down} down`) : undefined}
            tone={servicesDown > 0 ? "warning" : undefined}
          />
        </KpiStrip>
      )}
      <div className={styles.split}>
        <Loaded query={actions} fallback={<ChartSkeleton />}>
          {(a) => (
            <TimeChart
              title="Transactions"
              bucket={bucket}
              stacked
              series={[
                { id: "user", label: "User intent", tone: "accent", kind: "bar", points: a.series.user },
                { id: "maintenance", label: "Maintenance", tone: "muted", kind: "bar", points: a.series.maintenance },
              ]}
            />
          )}
        </Loaded>
        <Loaded query={traffic} fallback={<ChartSkeleton />}>
          {(t) => (
            <TimeChart
              title="Traffic"
              bucket={bucket}
              series={[
                { id: "views", label: "Views", tone: "faint", kind: "bar", points: t.views },
                { id: "visits", label: "Visits", tone: "accent", kind: "bar", points: t.visits },
              ]}
            />
          )}
        </Loaded>
      </div>
    </>
  );
}
