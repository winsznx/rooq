"use client";

import { formatAge } from "@rooq/sdk";
import type { AdminServices, ServiceState } from "@rooq/private-sdk/admin";
import { StateBlock } from "@/components/primitives";
import { useAdminServices } from "@/lib/admin/hooks";
import { useNow } from "@/lib/use-now";
import { Kpi, KpiStrip } from "./kpi";
import { AdminPageHead } from "./page-head";
import { Loaded, TableSkeleton } from "./query-state";
import { SERVICE_COLUMNS, ServiceRow } from "./service-row";

function ServicesBody({ data }: { data: AdminServices }): React.JSX.Element {
  const now = useNow();
  const tally = (state: ServiceState): number => data.services.filter((s) => s.state === state).length;
  const degraded = tally("degraded");
  const down = tally("down");
  if (data.services.length === 0) return <StateBlock kind="empty" title="No services reported" body="The analytics service returned an empty list. Check its port map." />;
  return (
    <>
      <KpiStrip label="Service states">
        <Kpi label="Operational" value={String(tally("ok"))} sub={`of ${data.services.length}`} />
        <Kpi label="Degraded" value={String(degraded)} sub="Answering, not healthy" tone={degraded > 0 ? "warning" : undefined} />
        <Kpi label="Down" value={String(down)} sub="Not answering" tone={down > 0 ? "warning" : undefined} />
        <Kpi label="Checked" value={formatAge(now - data.checkedAt)} sub="Polled every 15s" />
      </KpiStrip>
      <div className="panel table-scroll">
        <table className="table">
          <caption className="sr-only">State of each private service, from its own health endpoint</caption>
          <thead>
            <tr>
              {SERVICE_COLUMNS.map((c) => (
                <th key={c.label} scope="col" className={c.numeric ? "n" : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.services.map((s) => (
              <ServiceRow key={s.name} service={s} now={now} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ServicesView(): React.JSX.Element {
  const services = useAdminServices();
  return (
    <>
      <AdminPageHead title="Services" lede="Each private service's own health report, read over loopback on the server. Counters and errors reset when a service restarts." />
      <Loaded query={services} fallback={<TableSkeleton label="Loading services" rows={8} />}>
        {(data) => <ServicesBody data={data} />}
      </Loaded>
    </>
  );
}
