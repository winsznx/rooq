import type { AdminTrafficRow } from "@rooq/private-sdk/admin";
import { StateBlock } from "@/components/primitives";
import styles from "@/app/admin/admin.module.css";
import { count } from "./format";

/** Views and visits per key, largest first, with a share bar that only restates the views column. */
export function BreakdownTable({
  title,
  keyLabel,
  rows,
  limit = 12,
  describe,
}: {
  title: string;
  keyLabel: string;
  rows: readonly AdminTrafficRow[];
  limit?: number;
  describe?: (key: string) => string;
}): React.JSX.Element {
  const sorted = [...rows].sort((a, b) => b.views - a.views);
  const shown = sorted.slice(0, limit);
  const totalViews = sorted.reduce((acc, r) => acc + r.views, 0);
  return (
    <section className="panel" aria-label={title}>
      <div className="panel-head">
        <h2 className={styles.panelTitle}>{title}</h2>
        {sorted.length > limit ? <span className="t-small faint">{`Top ${limit} of ${sorted.length}`}</span> : null}
      </div>
      {shown.length === 0 ? (
        <StateBlock kind="empty" title="No views in this range" />
      ) : (
        <div className="table-scroll">
          <table className="table">
            <caption className="sr-only">{`${title}: views and visits`}</caption>
            <thead>
              <tr>
                <th scope="col">{keyLabel}</th>
                <th scope="col" className="n">
                  Views
                </th>
                <th scope="col" className="n">
                  Visits
                </th>
                <th scope="col" className="n">
                  <span className="sr-only">Share of views</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key}>
                  <th scope="row" style={{ fontWeight: 400 }}>
                    <span className={describe ? styles.key : `num ${styles.key}`} style={{ display: "inline-block" }} title={r.key}>
                      {describe ? describe(r.key) : r.key}
                    </span>
                  </th>
                  <td className="n">{count(r.views)}</td>
                  <td className="n">{count(r.visits)}</td>
                  <td className="n">
                    <span className={styles.share} aria-hidden>
                      <span className={styles.shareFill} style={{ width: `${totalViews > 0 ? (r.views / totalViews) * 100 : 0}%` }} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
