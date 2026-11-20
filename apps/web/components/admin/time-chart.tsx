"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { HistogramSeries, LineSeries, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type Time, type UTCTimestamp } from "lightweight-charts";
import type { AdminBucket, SeriesPoint } from "@rooq/private-sdk/admin";
import { chartTheme, cssVar, watchTheme } from "@/lib/chart-theme";
import styles from "@/app/admin/admin.module.css";
import { count } from "./format";
import { peak, total } from "./series";

export type ChartTone = "accent" | "ink" | "muted" | "faint";

export interface ChartSeries {
  readonly id: string;
  readonly label: string;
  readonly tone: ChartTone;
  readonly kind: "bar" | "line";
  readonly points: readonly SeriesPoint[];
}

const TONE_VAR: Record<ChartTone, string> = {
  accent: "--rq-accent",
  ink: "--rq-ink",
  muted: "--rq-ink-tertiary",
  faint: "--rq-line-strong",
};

interface Drawn {
  readonly api: ISeriesApi<"Histogram"> | ISeriesApi<"Line">;
  readonly kind: ChartSeries["kind"];
  readonly tone: ChartTone;
}

/** How values read on the axis and in the legend. `minMove` is the smallest step the axis labels resolve. */
export interface ChartFormat {
  readonly value: (v: number) => string;
  readonly minMove: number;
}

export const COUNT_FORMAT: ChartFormat = { value: count, minMove: 1 };

function priceFormat(format: ChartFormat): { type: "custom"; minMove: number; formatter: (v: number) => string } {
  return { type: "custom", minMove: format.minMove, formatter: format.value };
}

function toData(points: readonly SeriesPoint[]): { time: UTCTimestamp; value: number }[] {
  return [...points].sort((a, b) => a.t - b.t).map((p) => ({ time: p.t as UTCTimestamp, value: p.v }));
}

/**
 * Bars stack by drawing running totals back to front: the full stack first, the bottom layer last.
 * Each layer keeps its own id, so the legend still reads the unstacked values.
 */
function stackLayers(series: readonly ChartSeries[]): ChartSeries[] {
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const running = new Map<number, number>(times.map((t) => [t, 0]));
  const layers = series.map((s) => {
    const own = new Map(s.points.map((p) => [p.t, p.v]));
    const points = times.map((t) => {
      const v = (running.get(t) ?? 0) + (own.get(t) ?? 0);
      running.set(t, v);
      return { t, v };
    });
    return { ...s, kind: "bar" as const, points };
  });
  return layers.reverse();
}

function bucketTime(t: number, bucket: AdminBucket): string {
  const opts: Intl.DateTimeFormatOptions = bucket === "hour" ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false } : { month: "short", day: "numeric", timeZone: "UTC" };
  return `${new Intl.DateTimeFormat("en-US", opts).format(new Date(t * 1000))}${bucket === "hour" ? " UTC" : ""}`;
}

function crosshairTime(param: MouseEventParams<Time>): number | null {
  return typeof param.time === "number" ? param.time : null;
}

/** Values per bucket over time. Hovering a bucket reads its values into the legend; otherwise the legend shows range totals. */
export function TimeChart({
  title,
  series,
  bucket,
  stacked = false,
  cumulative = false,
  format = COUNT_FORMAT,
  plain = false,
}: {
  title: string;
  series: readonly ChartSeries[];
  bucket: AdminBucket;
  stacked?: boolean;
  /** The series are levels, such as running totals or a price, so the legend shows the latest value instead of a sum. */
  cumulative?: boolean;
  /** Pass a module-level constant: a new object every render re-applies the axis format. */
  format?: ChartFormat;
  /** Drawn inside a panel that already frames and titles it, so the title is kept for screen readers only. */
  plain?: boolean;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const drawnRef = useRef(new Map<string, Drawn>());
  const [hover, setHover] = useState<number | null>(null);

  // Callers build series inline, so identity changes on every parent render. Keying on content keeps
  // an unrelated re-render from re-feeding the chart and resetting its zoom.
  const content = JSON.stringify(series);
  const layers = useMemo(() => {
    const parsed = JSON.parse(content) as ChartSeries[];
    return stacked ? stackLayers(parsed) : parsed;
  }, [content, stacked]);
  const empty = series.every((s) => s.points.every((p) => p.v === 0));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, { autoSize: true, ...chartTheme(), crosshair: { mode: 1 }, handleScroll: false, handleScale: false });
    chartRef.current = chart;
    const drawn = drawnRef.current;
    const onMove = (param: MouseEventParams<Time>) => setHover(crosshairTime(param));
    chart.subscribeCrosshairMove(onMove);
    const unwatch = watchTheme(() => {
      chart.applyOptions(chartTheme());
      drawn.forEach((d) => d.api.applyOptions({ color: cssVar(TONE_VAR[d.tone]) }));
    });
    return () => {
      unwatch();
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      drawn.clear();
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({ timeScale: { timeVisible: bucket === "hour", secondsVisible: false } });
  }, [bucket]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const drawn = drawnRef.current;
    const wanted = new Set(layers.map((s) => s.id));
    for (const [id, d] of drawn) {
      if (wanted.has(id)) continue;
      chart.removeSeries(d.api);
      drawn.delete(id);
    }
    for (const s of layers) {
      const existing = drawn.get(s.id);
      if (existing && existing.kind !== s.kind) {
        chart.removeSeries(existing.api);
        drawn.delete(s.id);
      }
    }
    // Series draw in the order they were added, so a reordered stack is rebuilt from the back.
    const order = [...drawn.keys()];
    if (order.some((id, i) => layers[i]?.id !== id)) {
      drawn.forEach((d) => chart.removeSeries(d.api));
      drawn.clear();
    }
    for (const s of layers) {
      const color = cssVar(TONE_VAR[s.tone]);
      let d = drawn.get(s.id);
      if (!d) {
        const api =
          s.kind === "bar"
            ? chart.addSeries(HistogramSeries, { color, priceFormat: priceFormat(format), priceLineVisible: false, lastValueVisible: false })
            : chart.addSeries(LineSeries, { color, lineWidth: 2, priceFormat: priceFormat(format), priceLineVisible: false, lastValueVisible: false });
        d = { api, kind: s.kind, tone: s.tone };
        drawn.set(s.id, d);
      } else {
        d.api.applyOptions({ priceFormat: priceFormat(format) });
        if (d.tone !== s.tone) {
          d.api.applyOptions({ color });
          d = { ...d, tone: s.tone };
          drawn.set(s.id, d);
        }
      }
      d.api.setData(toData(s.points));
    }
    chart.timeScale().fitContent();
  }, [layers, format]);

  const legend = series.map((s) => {
    const at = hover === null ? null : s.points.find((p) => p.t === hover);
    const value = hover !== null ? (at?.v ?? 0) : cumulative ? (s.points.at(-1)?.v ?? 0) : total(s.points);
    return { s, value };
  });
  const summary = series
    .map((s) => {
      const top = peak(s.points);
      return `${s.label}: ${cumulative ? `latest ${format.value(s.points.at(-1)?.v ?? 0)}` : `total ${format.value(total(s.points))}`}${top && !cumulative ? `, peak ${format.value(top.v)} at ${bucketTime(top.t, bucket)}` : ""}.`;
    })
    .join(" ");

  return (
    <figure className={styles.figure} data-plain={plain || undefined}>
      <div className={styles.figHead}>
        <figcaption className={plain ? "sr-only" : styles.figTitle}>{title}</figcaption>
        <ul className={styles.legend} aria-label={hover === null ? "Range values" : `Values at ${bucketTime(hover, bucket)}`}>
          {hover !== null ? <li className="num">{bucketTime(hover, bucket)}</li> : null}
          {legend.map(({ s, value }) => (
            <li key={s.id} className={styles.legendItem}>
              <span className={styles.swatch} data-tone={s.tone} data-kind={s.kind} aria-hidden />
              {s.label}
              <span className={styles.legendValue}>{format.value(value)}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="sr-only">{summary}</p>
      {empty ? (
        <div className={`state ${styles.figEmpty}`} data-kind="empty">
          <p className="state-title">Nothing in this range</p>
          <p className="state-body">Pick a longer range, or check back once the indexer has caught up.</p>
        </div>
      ) : null}
      <div ref={containerRef} className={styles.canvas} hidden={empty} aria-hidden />
    </figure>
  );
}
