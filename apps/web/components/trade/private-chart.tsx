"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, LineSeries, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { chartTheme, cssVar } from "@/lib/chart-theme";
import { CANDLE_RESOLUTIONS, RESOLUTION_LABEL, isSessionClosed, pythSymbolFor, type CandleResolution } from "@/lib/pyth/candles";
import { useCandles } from "@/lib/pyth/use-candles";
import type { PricePoint } from "@/lib/private/types";
import { Segmented } from "../primitives";
import styles from "./trade.module.css";

export interface ChartLevel {
  readonly key: string;
  readonly label: string;
  readonly price: number;
  readonly tone: "entry" | "liquidation";
}

const RESOLUTION_OPTIONS = CANDLE_RESOLUTIONS.map((value) => ({ value, label: RESOLUTION_LABEL[value] }));

function oracleLineStyle(withCandles: boolean) {
  return withCandles ? { color: cssVar("--rq-accent"), lineWidth: 2 as const } : { color: cssVar("--rq-ink"), lineWidth: 2 as const };
}

function candleColors() {
  const up = cssVar("--rq-positive");
  const down = cssVar("--rq-negative");
  return { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down };
}

/**
 * Pyth candles for the underlying share when available, with Rooq's oracle price drawn on top. Trades, funding and
 * liquidation use the oracle line, so entry and liquidation levels attach to it. Without candles the chart is the
 * oracle line alone, as before.
 */
export function PrivateChart({ symbol, history, levels }: { symbol: string; history: readonly PricePoint[]; levels: readonly ChartLevel[] }) {
  const [resolution, setResolution] = useState<CandleResolution>("15");
  const hasFeed = pythSymbolFor(symbol) !== null;
  const { data, dataUpdatedAt } = useCandles(symbol, resolution);
  const candles = useMemo(() => data?.candles ?? [], [data]);
  const withCandles = candles.length > 0;
  // Measured against the time these candles were fetched, so the badge refreshes with each refetch.
  const closed = withCandles && isSessionClosed(candles, resolution, Math.floor(dataUpdatedAt / 1000));

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, { autoSize: true, ...chartTheme(), crosshair: { mode: 1 } });
    candleRef.current = chart.addSeries(CandlestickSeries, { ...candleColors(), lastValueVisible: false, priceLineVisible: false });
    // The last price is in the header. A tag on the axis would only cover the axis labels.
    lineRef.current = chart.addSeries(LineSeries, { ...oracleLineStyle(false), lastValueVisible: false, priceLineVisible: false });
    chartRef.current = chart;
    const observer = new MutationObserver(() => {
      chart.applyOptions(chartTheme());
      candleRef.current?.applyOptions(candleColors());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      lineRef.current = null;
      linesRef.current = [];
    };
  }, []);

  useEffect(() => {
    candleRef.current?.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    lineRef.current?.applyOptions(oracleLineStyle(withCandles));
    chartRef.current?.timeScale().fitContent();
  }, [candles, withCandles]);

  useEffect(() => {
    lineRef.current?.setData(history.map((p) => ({ time: p.time as UTCTimestamp, value: p.price })));
    chartRef.current?.timeScale().fitContent();
  }, [history]);

  useEffect(() => {
    const series = lineRef.current;
    if (!series) return;
    linesRef.current.forEach((l) => series.removePriceLine(l));
    linesRef.current = levels.map((l) => series.createPriceLine({ price: l.price, title: l.label, color: cssVar(l.tone === "liquidation" ? "--rq-negative" : "--rq-ink-tertiary"), lineWidth: 1, lineStyle: 2, axisLabelVisible: true }));
  }, [levels]);

  return (
    <section className={styles.chart} aria-label="Price chart">
      <div className={styles.chartHead}>
        <span className={styles.chartLegend}>
          <span className="tag" data-tone="test">TEST price relay, single operator</span>
          {withCandles ? (
            <span className="t-small muted">Candles: {symbol} share price, via Pyth Network. Line: Rooq oracle, used for trades.</span>
          ) : (
            <span className="t-small muted">Oracle price</span>
          )}
        </span>
        {hasFeed ? <Segmented label="Candle size" options={RESOLUTION_OPTIONS} value={resolution} onChange={setResolution} /> : null}
      </div>
      <div className={styles.chartBody}>
        <div ref={containerRef} className={styles.chartCanvas} />
        {closed ? <p className={styles.chartClosed}>US market closed. Candles resume next session, and the oracle line keeps updating.</p> : null}
      </div>
    </section>
  );
}
