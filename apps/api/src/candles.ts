import type { Candle, ChartResponse } from "@rooq/sdk";
import { badRequest } from "./errors";

export type Interval = ChartResponse["interval"];

const SECONDS: Record<Interval, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3_600, "4h": 14_400, "1d": 86_400 };

function isInterval(value: string): value is Interval {
  return Object.hasOwn(SECONDS, value);
}

export function parseInterval(raw: string | null): { interval: Interval; seconds: number } {
  const interval = raw ?? "1h";
  if (!isInterval(interval)) throw badRequest(`interval must be one of ${Object.keys(SECONDS).join(", ")}.`);
  return { interval, seconds: SECONDS[interval] };
}

export interface CandleSource {
  readonly t: bigint;
  readonly o: string;
  readonly h: string;
  readonly l: string;
  readonly c: string;
  readonly v: string;
}

/**
 * Newest-first database buckets to oldest-first candles. Only buckets that contain executions exist:
 * nothing is interpolated, forward-filled or invented, so no executions means an empty array.
 */
export function toCandles(rows: readonly CandleSource[]): Candle[] {
  return [...rows].reverse().map((r) => ({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
}
