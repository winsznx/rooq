import type { ReactNode } from "react";
import type { SeriesPoint } from "@rooq/private-sdk/admin";
import { Skeleton } from "@/components/primitives";
import styles from "@/app/admin/admin.module.css";
import { Sparkline } from "./sparkline";

/** `columns` pins a wide layout so a known set of tiles fills whole rows on desktop. */
export function KpiStrip({ label, columns, children }: { label: string; columns?: number; children: ReactNode }): React.JSX.Element {
  return (
    <section className={styles.kpis} aria-label={label} data-columns={columns} style={columns ? ({ "--kpi-columns": columns } as React.CSSProperties) : undefined}>
      {children}
    </section>
  );
}

/** `value` undefined means still loading; pass the formatted unknown mark for a figure that can't be read. */
export function Kpi({
  label,
  value,
  sub,
  trend,
  tone,
}: {
  label: string;
  value: string | undefined;
  sub?: ReactNode;
  trend?: readonly SeriesPoint[];
  tone?: "warning";
}): React.JSX.Element {
  return (
    <div className={styles.kpi} data-tone={tone}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={styles.kpiValue}>{value === undefined ? <Skeleton width="60%" height={22} /> : value}</span>
      <span className={styles.kpiSub}>{sub ?? " "}</span>
      <Sparkline points={trend} />
    </div>
  );
}
