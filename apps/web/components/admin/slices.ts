import { shortAddress } from "@rooq/sdk";
import type { AdminActionSeries, AdminVault, AssetAmount, SeriesPoint } from "@rooq/private-sdk/admin";
import { actionLabel } from "./format";
import { sumSeries, total } from "./series";

export interface NamedSeries {
  readonly id: string;
  readonly label: string;
  readonly points: SeriesPoint[];
}

/** The `keep` busiest kinds by range total, the rest folded into one "Other" layer so a stack stays readable. */
export function topKinds(kinds: readonly AdminActionSeries[], keep: number): NamedSeries[] {
  const ranked = [...kinds]
    .map((k) => ({ k, sum: total(k.series) }))
    .filter((r) => r.sum > 0)
    .sort((a, b) => b.sum - a.sum);
  const shown: NamedSeries[] = ranked.slice(0, keep).map(({ k }) => ({ id: k.action, label: actionLabel(k.action), points: k.series }));
  const rest = ranked.slice(keep);
  if (rest.length === 1) {
    const only = rest[0]!.k;
    shown.push({ id: only.action, label: actionLabel(only.action), points: only.series });
  } else if (rest.length > 1) {
    shown.push({ id: "other", label: `${rest.length} other kinds`, points: sumSeries(rest.map((r) => r.k.series)) });
  }
  return shown;
}

export function assetLabel(a: Pick<AssetAmount, "asset" | "symbol" | "decimalsKnown">): string {
  return a.decimalsKnown ? a.symbol : shortAddress(a.asset);
}

export interface DonutSlice {
  readonly id: string;
  readonly label: string;
  /** Percent of the whole, 0 to 100. */
  readonly pct: number;
  readonly usd: number | null;
}

/** The `keep` largest holdings by share; smaller ones join "Other". Unpriced assets carry no share, so they sit out of the ring. */
export function vaultSlices(vault: AdminVault, keep: number): DonutSlice[] {
  const ranked = [...vault.assets].filter((a) => a.sharePct > 0).sort((a, b) => b.sharePct - a.sharePct);
  const slices: DonutSlice[] = ranked.slice(0, keep).map((a) => ({ id: a.asset, label: assetLabel(a), pct: a.sharePct, usd: a.usd }));
  const rest = ranked.slice(keep);
  if (rest.length > 0) {
    slices.push({
      id: "other",
      label: rest.length === 1 ? assetLabel(rest[0]!) : `${rest.length} others`,
      pct: rest.reduce((acc, a) => acc + a.sharePct, 0),
      usd: rest.reduce((acc, a) => acc + (a.usd ?? 0), 0),
    });
  }
  return slices;
}

/** Two parts as percentages of their sum, for a split bar. Both 0 when there is nothing to split. */
export function splitPct(a: number, b: number): [number, number] {
  const sum = a + b;
  if (!(sum > 0)) return [0, 0];
  return [(a / sum) * 100, (b / sum) * 100];
}

/** Rate in basis points as a percentage string with up to two decimals: 70 reads as "0.7%". */
export function bpsLabel(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}
