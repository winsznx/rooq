import { ADMIN_BUCKETS, ADMIN_RANGES, type AdminBucket, type AdminRange, type SeriesPoint } from "@rooq/private-sdk/admin";
import { badRequest } from "./errors";

export const BUCKET_SECONDS: Readonly<Record<AdminBucket, number>> = { hour: 3_600, day: 86_400 };
const RANGE_SECONDS: Readonly<Record<Exclude<AdminRange, "all">, number>> = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400 };
/** Enough for a year of days; finer buckets over a long range are refused rather than drawn as noise. */
export const MAX_SERIES_POINTS = 2_000;

export interface Window {
  readonly range: AdminRange;
  readonly bucket: AdminBucket;
  /** Unix seconds; 0 for all time. */
  readonly since: number;
  readonly now: number;
}

const isRange = (v: string): v is AdminRange => (ADMIN_RANGES as readonly string[]).includes(v);
const isBucket = (v: string): v is AdminBucket => (ADMIN_BUCKETS as readonly string[]).includes(v);

export const bucketStart = (t: number, bucket: AdminBucket): number => Math.floor(t / BUCKET_SECONDS[bucket]) * BUCKET_SECONDS[bucket];

/**
 * `?range=24h|7d|30d|all&bucket=hour|day`. Hourly buckets by default up to a week, daily beyond. The window starts on a
 * bucket boundary, which is always a whole hour, so queries over hourly aggregates and over exact timestamps cover the
 * same span and the first bucket of every series is whole.
 */
export function parseWindow(url: URL, now: number): Window {
  const rawRange = url.searchParams.get("range") ?? "7d";
  if (!isRange(rawRange)) throw badRequest(`range must be one of ${ADMIN_RANGES.join(", ")}.`);
  const rawBucket = url.searchParams.get("bucket") ?? (rawRange === "24h" || rawRange === "7d" ? "hour" : "day");
  if (!isBucket(rawBucket)) throw badRequest(`bucket must be one of ${ADMIN_BUCKETS.join(", ")}.`);
  return { range: rawRange, bucket: rawBucket, since: rawRange === "all" ? 0 : bucketStart(now - RANGE_SECONDS[rawRange], rawBucket), now };
}

interface Counted {
  readonly t: number;
  readonly n: number;
}

/** Where an all-time chart starts: the earliest point of any series drawn together, so they share one axis. */
export function firstPoint(...series: readonly (readonly Counted[])[]): number | undefined {
  const firsts = series.map((s) => s[0]?.t).filter((t): t is number => t !== undefined);
  return firsts.length === 0 ? undefined : Math.min(...firsts);
}

/**
 * Zero-filled points from the window start (or `start`, for all time) to now, so charts show quiet periods as zero
 * instead of joining across them.
 */
export function denseSeries(points: readonly Counted[], w: Window, start = firstPoint(points)): SeriesPoint[] {
  const size = BUCKET_SECONDS[w.bucket];
  const first = w.since > 0 ? w.since : (start ?? w.now);
  const from = bucketStart(first, w.bucket);
  const to = bucketStart(w.now, w.bucket);
  if ((to - from) / size + 1 > MAX_SERIES_POINTS) throw badRequest(`Too many ${w.bucket} buckets for range ${w.range}; use bucket=day.`);
  const byT = new Map<number, number>();
  for (const p of points) {
    const t = bucketStart(p.t, w.bucket);
    byT.set(t, (byT.get(t) ?? 0) + p.n);
  }
  const out: SeriesPoint[] = [];
  for (let t = from; t <= to; t += size) out.push({ t, v: byT.get(t) ?? 0 });
  return out;
}

/** A running total that starts from what came before the window. */
export function cumulative(series: readonly SeriesPoint[], before: number): SeriesPoint[] {
  let total = before;
  return series.map((p) => ({ t: p.t, v: (total += p.v) }));
}
