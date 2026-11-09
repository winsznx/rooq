"use client";

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { formatTime, money, type Candle, type Timeframe } from "./data";
import styles from "./landing.module.css";

const VOLUME_SHARE = 0.17;
const AXIS_W = 58;
const AXIS_H = 22;
/** Height of the drawing in its own units. The SVG stretches to the plot, so it needs no measuring. */
const UNITS = 100;

const inPlotHeight = (units: number): string => `calc((100% - ${AXIS_H}px) * ${(units / UNITS).toFixed(4)})`;

/** Candles, a mark line with area, volume and a crosshair. Example data, drawn from a seeded walk. */
export function PriceChart({ candles, tf, label }: { candles: readonly Candle[]; tf: Timeframe; label: string }) {
  const [cursor, setCursor] = useState<number | null>(null);

  const priceH = UNITS * (1 - VOLUME_SHARE);
  const { lo, hi, maxV } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    let vol = 0;
    for (const c of candles) {
      min = Math.min(min, c.l, c.mark);
      max = Math.max(max, c.h, c.mark);
      vol = Math.max(vol, c.v);
    }
    const pad = (max - min) * 0.06;
    return { lo: min - pad, hi: max + pad, maxV: vol };
  }, [candles]);
  const y = (p: number) => ((hi - p) / (hi - lo)) * priceH;
  const xAt = (i: number) => i + 0.5;

  const markPath = candles.map((c, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)} ${y(c.mark).toFixed(2)}`).join(" ");
  const areaPath = `${markPath} L${xAt(candles.length - 1).toFixed(1)} ${priceH} L${xAt(0).toFixed(1)} ${priceH} Z`;
  const ticks = [0.08, 0.3, 0.52, 0.74, 0.94].map((f) => hi - (hi - lo) * f);
  const timeTicks = [0.1, 0.32, 0.54, 0.76, 0.96].map((f) => Math.floor(f * (candles.length - 1)));

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) / (rect.width - AXIS_W)) * candles.length);
    setCursor(Math.min(candles.length - 1, Math.max(0, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = candles.length - 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      setCursor((c) => Math.max(0, Math.min(last, (c ?? last) + dir)));
    } else if (e.key === "Escape") {
      setCursor(null);
    }
  };

  const shown = candles[cursor ?? candles.length - 1]!;
  const up = shown.c >= shown.o;
  return (
    <div className={styles.chart}>
      <p className={styles.readout} data-testid="chart-readout">
        <span className={styles.readTime}>{formatTime(shown.t, tf)}</span>
        <span className={styles.ohl}>O {money(shown.o)}</span>
        <span className={styles.ohl}>H {money(shown.h)}</span>
        <span className={styles.ohl}>L {money(shown.l)}</span>
        <span className={up ? styles.up : styles.down}>C {money(shown.c)}</span>
        <span className={styles.markKey}>Mark {money(shown.mark)}</span>
      </p>
      <div className={styles.plot} tabIndex={0} role="application" aria-label={`${label}. Example chart. Use the left and right arrow keys to read each candle.`} onPointerMove={onMove} onPointerLeave={() => setCursor(null)} onKeyDown={onKey} data-testid="chart-plot">
        <div className={styles.plotArea}>
          <svg viewBox={`0 0 ${candles.length} ${UNITS}`} preserveAspectRatio="none" role="presentation">
            {ticks.map((p) => (
              <line key={p} x1={0} x2={candles.length} y1={y(p)} y2={y(p)} className={styles.grid} />
            ))}
            <path d={areaPath} className={styles.area} />
            {candles.map((c, i) => {
              const top = y(Math.max(c.o, c.c));
              const height = Math.max(0.5, y(Math.min(c.o, c.c)) - top);
              const v = (c.v / maxV) * (UNITS * VOLUME_SHARE - 1);
              return (
                <g key={c.t} className={c.c >= c.o ? styles.up : styles.down}>
                  <rect x={i + 0.19} y={UNITS - v} width={0.62} height={v} className={styles.volume} />
                  <line x1={xAt(i)} x2={xAt(i)} y1={y(c.h)} y2={y(c.l)} className={styles.wick} />
                  <rect x={i + 0.19} y={top} width={0.62} height={height} />
                </g>
              );
            })}
            <path d={markPath} className={styles.markLine} />
            {cursor !== null ? (
              <g>
                <line x1={xAt(cursor)} x2={xAt(cursor)} y1={0} y2={UNITS} className={styles.cross} />
                <line x1={0} x2={candles.length} y1={y(candles[cursor]!.c)} y2={y(candles[cursor]!.c)} className={styles.cross} />
              </g>
            ) : null}
          </svg>
        </div>
        {ticks.map((p) => (
          <span key={p} className={styles.axisPrice} style={{ top: inPlotHeight(y(p)) }} data-chart-label>
            {money(p)}
          </span>
        ))}
        {timeTicks.map((i) => (
          <span key={i} className={styles.axisTime} style={{ left: `calc((100% - ${AXIS_W}px) * ${((i + 0.5) / candles.length).toFixed(4)})` }} data-chart-label>
            {formatTime(candles[i]!.t, tf)}
          </span>
        ))}
        {cursor !== null ? (
          <span className={styles.crossTag} style={{ top: inPlotHeight(y(candles[cursor]!.c)) }}>
            {money(candles[cursor]!.c)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
