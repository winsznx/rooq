"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartResponse } from "@rooq/sdk";
import { copy } from "@rooq/ui";
import { useChart, useTrades } from "@/lib/api-hooks";
import { Segmented } from "../primitives";
import styles from "./trade.module.css";

const INTERVALS: ChartResponse["interval"][] = ["1m", "15m", "1h", "1d"];
const INTERVAL_SECONDS: Record<ChartResponse["interval"], number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

/** Below this many fills per candle, a candle is a bid and an ask, not a price range. */
const MIN_FILLS_PER_CANDLE = 3;
const MIN_CANDLES = 12;
/** A market that barely moves still has a price; the axis never zooms tighter than 1% of it. */
const MIN_AXIS_SPAN = 0.01;

function withMinimumSpan(range: AutoscaleInfo | null): AutoscaleInfo | null {
  if (!range?.priceRange) return range;
  const { minValue, maxValue } = range.priceRange;
  const mid = (minValue + maxValue) / 2;
  const half = (mid * MIN_AXIS_SPAN) / 2;
  if (maxValue - minValue >= half * 2) return range;
  return { ...range, priceRange: { minValue: mid - half, maxValue: mid + half } };
}

type Candle = ChartResponse["series"][number]["candles"][number];
type LineSeriesApi = ISeriesApi<"Line">;
type CandleSeriesApi = ISeriesApi<"Candlestick">;

export interface ChartLevel {
  readonly key: string;
  readonly label: string;
  readonly price: number;
  readonly tone: "entry" | "liquidation";
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Display only: chart pixels need floats. Money math never uses this. */
function toNumber(wadString: string): number {
  return Number(BigInt(wadString) / 10n ** 12n) / 1e6;
}

function chartTheme() {
  return {
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: cssVar("--rq-ink-secondary"),
      fontFamily: cssVar("--rq-font-data-stack") || "IBM Plex Mono",
      attributionLogo: false,
    },
    grid: { vertLines: { color: cssVar("--rq-chart-grid") }, horzLines: { color: cssVar("--rq-chart-grid") } },
    rightPriceScale: { borderColor: cssVar("--rq-line") },
    timeScale: { borderColor: cssVar("--rq-line"), timeVisible: true },
  };
}

function seriesTheme() {
  return {
    candle: {
      upColor: cssVar("--rq-positive"),
      downColor: cssVar("--rq-negative"),
      borderVisible: false,
      wickUpColor: cssVar("--rq-positive"),
      wickDownColor: cssVar("--rq-negative"),
    },
    line: { color: cssVar("--rq-ink-tertiary") },
  };
}

const toCandle = (c: Candle) => ({ time: c.t as UTCTimestamp, open: toNumber(c.o), high: toNumber(c.h), low: toNumber(c.l), close: toNumber(c.c) });
const EMPTY_CANDLES: readonly Candle[] = [];
const toPoint = (c: Candle) => ({ time: c.t as UTCTimestamp, value: toNumber(c.c) });

/** True when `next` only changes the newest bar or adds bars after it, which an incremental update can apply. */
function isAppend(prev: readonly Candle[], next: readonly Candle[]): boolean {
  if (prev.length === 0 || next.length < prev.length) return false;
  for (let i = 0; i < prev.length - 1; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a.t !== b.t || a.o !== b.o || a.h !== b.h || a.l !== b.l || a.c !== b.c) return false;
  }
  return next[prev.length - 1]!.t === prev[prev.length - 1]!.t;
}

/**
 * Real chart from indexed executed trades only; oracle observations are a separate labelled series.
 * The chart instance lives as long as this component. Data refreshes are applied incrementally, so zoom
 * and pan survive every poll. Only a new interval, market or mode refits the viewport.
 */
export function ChartPanel({ marketId, mode, levels = [] }: { marketId: string; mode: "spot" | "perps"; levels?: readonly ChartLevel[] }) {
  const [interval, setChartInterval] = useState<ChartResponse["interval"]>("15m");
  const { data, isLoading, isError } = useChart(marketId, interval);
  const { data: tradeData } = useTrades(marketId);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<CandleSeriesApi | null>(null);
  const lineRef = useRef<LineSeriesApi | null>(null);
  const appliedRef = useRef<{ view: string; candles: readonly Candle[]; points: readonly Candle[] } | null>(null);
  const priceLinesRef = useRef<{ series: CandleSeriesApi | LineSeriesApi; line: IPriceLine }[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const source = mode === "spot" ? "pool" : "perp";
  const fillKind = mode === "spot" ? "swap" : "perp";
  const fills = useMemo(() => (tradeData?.trades ?? []).filter((t) => t.kind === fillKind && t.canonical), [tradeData, fillKind]);
  const rawCandles = useMemo(() => data?.series.find((s) => s.source === source)?.candles ?? [], [data, source]);
  const oracle = useMemo(() => (mode === "perps" ? (data?.series.find((s) => s.source === "oracle")?.candles ?? []) : []), [data, mode]);

  // One bucket with a single buy and a single sell draws a full candle made only of the maker's spread.
  // Until a market trades often enough, show the fills themselves against the reference line.
  const sparse = rawCandles.length > 0 && (rawCandles.length < MIN_CANDLES || fills.length / rawCandles.length < MIN_FILLS_PER_CANDLE);
  const candles = sparse ? EMPTY_CANDLES : rawCandles;
  const points = mode === "perps" ? oracle : sparse ? rawCandles : EMPTY_CANDLES;
  const hasData = candles.length > 0 || points.length > 0;
  const view = `${marketId}:${mode}:${interval}:${sparse ? "sparse" : "candles"}`;
  const levelsKey = levels.map((l) => `${l.key}:${l.price}`).join("|");
  const hasCandles = candles.length > 0;
  const hasPoints = points.length > 0;
  const showMarkers = false; // Single fills are never drawn: a per-fill tape has no place in a private market.
  const markerKey = showMarkers ? fills.map((t) => `${t.txHash}:${t.logIndex}`).join(",") + interval : "";

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, { autoSize: true, ...chartTheme(), crosshair: { mode: 1 } });
    const themed = seriesTheme();
    const autoscale = { autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => withMinimumSpan(base()) };
    candleRef.current = chart.addSeries(CandlestickSeries, { ...themed.candle, ...autoscale });
    lineRef.current = chart.addSeries(LineSeries, { ...themed.line, ...autoscale, lineWidth: 1, lineStyle: 2, visible: false });
    markersRef.current = createSeriesMarkers(lineRef.current, []);
    chartRef.current = chart;
    const observer = new MutationObserver(() => {
      chart.applyOptions(chartTheme());
      const next = seriesTheme();
      candleRef.current?.applyOptions(next.candle);
      lineRef.current?.applyOptions(next.line);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      lineRef.current = null;
      markersRef.current = null;
      appliedRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleRef.current;
    const lineSeries = lineRef.current;
    if (!chart || !candleSeries || !lineSeries || !data) return;

    candleSeries.applyOptions({ title: mode === "spot" ? "Rooq pool trades" : "Rooq perp fills" });
    lineSeries.applyOptions({ visible: points.length > 0, title: mode === "spot" ? "Rooq pool trades" : "TEST oracle" });

    const applied = appliedRef.current;
    const newView = applied?.view !== view;
    const candlesAppend = !newView && applied !== null && isAppend(applied.candles, candles);
    const pointsAppend = !newView && applied !== null && isAppend(applied.points, points);

    if (candlesAppend) {
      for (const c of candles.slice(applied.candles.length - 1)) candleSeries.update(toCandle(c));
    }
    if (pointsAppend) {
      for (const c of points.slice(applied.points.length - 1)) lineSeries.update(toPoint(c));
    }
    if (!candlesAppend || !pointsAppend) {
      // History itself changed (reorg, backfill) or a new view: replace it, holding the viewport unless the view changed.
      const range = newView ? null : chart.timeScale().getVisibleLogicalRange();
      if (!candlesAppend) candleSeries.setData(candles.map(toCandle));
      if (!pointsAppend) lineSeries.setData(points.map(toPoint));
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    }
    if (newView && (candles.length > 0 || points.length > 0)) chart.timeScale().fitContent();
    appliedRef.current = { view, candles, points };
  }, [data, candles, points, mode, view]);

  useEffect(() => {
    const series = hasCandles ? candleRef.current : hasPoints ? lineRef.current : null;
    for (const old of priceLinesRef.current) old.series.removePriceLine(old.line);
    priceLinesRef.current = [];
    if (!series) return;
    const color = (tone: ChartLevel["tone"]) => (tone === "entry" ? cssVar("--rq-accent") : cssVar("--rq-negative"));
    priceLinesRef.current = levels.map((l) => ({
      series,
      line: series.createPriceLine({ price: l.price, color: color(l.tone), lineWidth: 1, lineStyle: l.tone === "entry" ? 0 : 2, axisLabelVisible: true, title: l.label }),
    }));
    // levelsKey carries the identity of `levels`; rows re-created with the same values must not redraw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelsKey, hasCandles, hasPoints]);

  useEffect(() => {
    const plugin = markersRef.current;
    if (!plugin) return;
    if (!showMarkers) {
      plugin.setMarkers([]);
      return;
    }
    const bucket = INTERVAL_SECONDS[interval];
    const up = cssVar("--rq-positive");
    const down = cssVar("--rq-negative");
    const markers: SeriesMarker<Time>[] = [...fills]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((t) => {
        const buy = BigInt(t.size) >= 0n;
        return { time: (Math.floor(t.timestamp / bucket) * bucket) as UTCTimestamp, position: "atPriceMiddle" as const, price: toNumber(t.price), shape: buy ? ("arrowUp" as const) : ("arrowDown" as const), color: buy ? up : down, size: 1 };
      });
    plugin.setMarkers(markers);
    // markerKey carries the identity of `fills`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerKey, showMarkers, interval]);

  return (
    <section className={styles.chart} aria-label="Price chart">
      <div className={styles.chartHead}>
        <span className={styles.chartLegend}>
          <span className="tag" data-tone="test">
            {copy.system.demo}
          </span>
          <span className="t-small muted">{sparse ? "Too little trading for candles. The line is the reference price." : mode === "spot" ? "Pool reference price" : "Reference price"}</span>
        </span>
        <Segmented label="Chart interval" options={INTERVALS.map((i) => ({ value: i, label: i }))} value={interval} onChange={setChartInterval} />
      </div>
      <div className={styles.chartBody}>
        <div ref={containerRef} className={styles.chartCanvas} data-empty={!hasData} />
        {isLoading ? (
          <p className={styles.chartNote}>Loading indexed trades.</p>
        ) : isError ? (
          <p className={styles.chartNote}>Chart data is unavailable because the indexer API is not responding. Prices and balances on this page still come straight from the chain.</p>
        ) : !hasData ? (
          <p className={styles.chartNote}>No trades yet.</p>
        ) : null}
      </div>
    </section>
  );
}
