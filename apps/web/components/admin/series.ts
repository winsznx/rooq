import type { SeriesPoint } from "@rooq/private-sdk/admin";

/** Adds series point by point over the union of their bucket starts. A missing bucket counts as zero. */
export function sumSeries(list: readonly (readonly SeriesPoint[])[]): SeriesPoint[] {
  const totals = new Map<number, number>();
  for (const series of list) for (const p of series) totals.set(p.t, (totals.get(p.t) ?? 0) + p.v);
  return [...totals.entries()].sort(([a], [b]) => a - b).map(([t, v]) => ({ t, v }));
}

export function total(series: readonly SeriesPoint[]): number {
  return series.reduce((acc, p) => acc + p.v, 0);
}

export function peak(series: readonly SeriesPoint[]): SeriesPoint | null {
  return series.reduce<SeriesPoint | null>((best, p) => (best === null || p.v > best.v ? p : best), null);
}
