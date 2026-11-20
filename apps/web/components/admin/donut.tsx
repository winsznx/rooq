import type { ReactNode } from "react";
import styles from "@/app/admin/admin.module.css";
import type { DonutSlice } from "./slices";
import type { ChartTone } from "./time-chart";

const SIZE = 120;
const RADIUS = 48;
const STROKE = 14;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Hairline gap between neighbouring slices, in the same units as the circumference. */
const GAP = 1.6;
/** Largest first, so the accent always marks the biggest holding and "Other" the faintest. */
export const DONUT_TONES: readonly ChartTone[] = ["accent", "ink", "muted", "faint"];

interface Arc {
  readonly slice: DonutSlice;
  readonly tone: ChartTone;
  readonly length: number;
  readonly offset: number;
}

function arcs(slices: readonly DonutSlice[]): Arc[] {
  const whole = slices.reduce((acc, s) => acc + s.pct, 0);
  if (whole <= 0) return [];
  const gap = slices.length > 1 ? GAP : 0;
  let start = 0;
  return slices.map((slice, i) => {
    const span = (slice.pct / whole) * CIRCUMFERENCE;
    const arc = { slice, tone: DONUT_TONES[Math.min(i, DONUT_TONES.length - 1)]!, length: Math.max(span - gap, 0.5), offset: start };
    start += span;
    return arc;
  });
}

/**
 * A ring of shares with its figure in the middle. The ring is decorative: the legend next to it carries every value,
 * so screen readers get the list, not the drawing.
 */
export function Donut({ slices, center }: { slices: readonly DonutSlice[]; center: ReactNode }): React.JSX.Element {
  const drawn = arcs(slices);
  return (
    <div className={styles.donut}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className={styles.donutRing} aria-hidden focusable="false">
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className={styles.donutTrack} />
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          {drawn.map((a) => (
            <circle
              key={a.slice.id}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              strokeDasharray={`${a.length} ${CIRCUMFERENCE - a.length}`}
              strokeDashoffset={-a.offset}
              className={styles.donutArc}
              data-tone={a.tone}
            />
          ))}
        </g>
      </svg>
      <div className={styles.donutCenter}>{center}</div>
    </div>
  );
}
