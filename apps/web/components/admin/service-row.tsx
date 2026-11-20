import { Fragment } from "react";
import { UNKNOWN, formatAge } from "@rooq/sdk";
import type { AdminService, ServiceState } from "@rooq/private-sdk/admin";
import styles from "@/app/admin/admin.module.css";
import { actionLabel, count, duration, eth, latency } from "./format";
import { healthCounts, healthError, healthNumber, healthString } from "./health";

const STATE: Record<ServiceState, { tone: "positive" | "warning" | "negative"; label: string }> = {
  ok: { tone: "positive", label: "Operational" },
  degraded: { tone: "warning", label: "Degraded" },
  down: { tone: "negative", label: "Down" },
};

export const SERVICE_COLUMNS: readonly { label: string; numeric: boolean }[] = [
  { label: "Service", numeric: false },
  { label: "State", numeric: false },
  { label: "Latency", numeric: true },
  { label: "Lag (blocks)", numeric: true },
  { label: "Last tick", numeric: true },
  { label: "Last error", numeric: false },
];

/** The status page's row, with the extra columns an operator needs. Counters reset whenever a service restarts. */
export function ServiceRow({ service, now }: { service: AdminService; now: number }): React.JSX.Element {
  const { health } = service;
  const state = STATE[service.state];
  const lag = healthNumber(health, "lagBlocks");
  const tickMs = healthNumber(health, "lastTickAgeMs");
  const uptime = healthNumber(health, "uptimeSeconds");
  const lastError = healthError(health);
  const blocked = healthString(health, "blocked");
  const gas = healthString(health, "gasBalanceWei");
  const counters = healthCounts(health, "counters");
  const backlog = healthCounts(health, "backlog");
  // A degraded service answers with its own lastError, which says more than the probe's "HTTP 503".
  const errorText = lastError?.message ?? service.error ?? null;
  const facts: { label: string; value: string }[] = [];
  if (uptime !== null) facts.push({ label: "Up for", value: duration(uptime) });
  if (gas !== null) facts.push({ label: "Gas balance", value: eth(gas) });
  for (const [key, n] of backlog) facts.push({ label: `Backlog: ${actionLabel(key).toLowerCase()}`, value: count(n) });
  for (const [key, n] of counters) facts.push({ label: actionLabel(key.replace(/_/g, " ")), value: count(n) });

  return (
    <Fragment>
      <tr className={facts.length > 0 ? styles.withDetails : undefined}>
        <th scope="row" style={{ height: 52 }}>
          {service.name}
        </th>
        <td>
          <span className="pill" data-tone={state.tone}>
            {state.label}
          </span>
          {blocked ? <span className="t-small warn" style={{ display: "block" }}>{`Blocked: ${blocked}`}</span> : null}
        </td>
        <td className="n">{latency(service.latencyMs)}</td>
        <td className="n">{lag === null ? UNKNOWN : count(lag)}</td>
        <td className="n">{tickMs === null ? UNKNOWN : formatAge(tickMs / 1000)}</td>
        <td className="t-small">
          {errorText ? (
            <span className={styles.error}>
              {errorText}
              {lastError?.at ? <span className={styles.errorAge}>{formatAge(now - lastError.at)}</span> : null}
            </span>
          ) : (
            <span className="faint">None</span>
          )}
        </td>
      </tr>
      {facts.length > 0 ? (
        <tr className={styles.subRow}>
          <td colSpan={SERVICE_COLUMNS.length}>
            <details className={styles.details}>
              <summary>
                Counters and backlog<span className="sr-only">{` for ${service.name}`}</span>
              </summary>
              <dl className={`facts ${styles.counters}`}>
                {facts.map((f) => (
                  <div key={f.label}>
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}
