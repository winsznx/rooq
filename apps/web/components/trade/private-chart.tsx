"use client";

import { useEffect, useRef } from "react";
import { ColorType, LineSeries, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { PricePoint } from "@/lib/private/types";
import styles from "./trade.module.css";

export interface ChartLevel {
  readonly key: string;
  readonly label: string;
  readonly price: number;
  readonly tone: "entry" | "liquidation";
}

const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function theme() {
  return {
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: cssVar("--rq-ink-secondary"), fontFamily: cssVar("--rq-font-data-stack") || "IBM Plex Mono", attributionLogo: false },
    grid: { vertLines: { color: cssVar("--rq-chart-grid") }, horzLines: { color: cssVar("--rq-chart-grid") } },
    rightPriceScale: { borderColor: cssVar("--rq-line") },
    timeScale: { borderColor: cssVar("--rq-line"), timeVisible: true },
  };
}

/** The market's oracle price over time. The header's price is the last point of this line, so the page reads one number. */
export function PrivateChart({ history, levels }: { history: readonly PricePoint[]; levels: readonly ChartLevel[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, { autoSize: true, ...theme(), crosshair: { mode: 1 } });
    // The last price is in the header. A tag on the axis would only cover the axis labels.
    seriesRef.current = chart.addSeries(LineSeries, { color: cssVar("--rq-ink"), lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
    chartRef.current = chart;
    const observer = new MutationObserver(() => chart.applyOptions(theme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(history.map((p) => ({ time: p.time as UTCTimestamp, value: p.price })));
    chartRef.current?.timeScale().fitContent();
  }, [history]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    linesRef.current.forEach((l) => series.removePriceLine(l));
    linesRef.current = levels.map((l) => series.createPriceLine({ price: l.price, title: l.label, color: cssVar(l.tone === "liquidation" ? "--rq-negative" : "--rq-ink-tertiary"), lineWidth: 1, lineStyle: 2, axisLabelVisible: true }));
  }, [levels]);

  return (
    <section className={styles.chart} aria-label="Price chart">
      <div className={styles.chartHead}>
        <span className={styles.chartLegend}>
          <span className="tag" data-tone="test">TEST price relay, single operator</span>
          <span className="t-small muted">Oracle price</span>
        </span>
      </div>
      <div className={styles.chartBody}>
        <div ref={containerRef} className={styles.chartCanvas} />
      </div>
    </section>
  );
}
