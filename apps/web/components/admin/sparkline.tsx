import type { SeriesPoint } from "@rooq/private-sdk/admin";
import styles from "@/app/admin/admin.module.css";

const WIDTH = 100;
const HEIGHT = 24;

/** The shape of a series, nothing more. Decorative: the tile's number and the detail pages carry the data. */
export function Sparkline({ points }: { points: readonly SeriesPoint[] | undefined }): React.JSX.Element {
  if (!points || points.length < 2) return <span className={styles.sparkEmpty} aria-hidden />;
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const step = WIDTH / (points.length - 1);
  const path = points.map((p, i) => `${(i * step).toFixed(2)},${(HEIGHT - 1 - ((p.v - min) / span) * (HEIGHT - 2)).toFixed(2)}`).join(" ");
  return (
    <svg className={styles.spark} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden focusable="false">
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
