import { UNKNOWN, formatCompact, formatFixed, formatLeverageTenths, formatPrice } from "@rooq/sdk";
import type { MarketSnapshot } from "./chain-data";

const WAD = 10n ** 18n;

/** Funding per hour as a signed percentage with four decimals, from a per-second WAD rate. */
export function fundingPerHour(ratePerSecondWad: bigint | null | undefined): string {
  if (ratePerSecondWad === null || ratePerSecondWad === undefined) return UNKNOWN;
  return `${formatFixed(ratePerSecondWad * 3600n * 100n, 18, 4, { sign: "always" })}%`;
}

export function fundingPayer(ratePerSecondWad: bigint): string {
  if (ratePerSecondWad > 0n) return "Longs pay shorts";
  if (ratePerSecondWad < 0n) return "Shorts pay longs";
  return "No funding at current balance";
}

export function usd(wad: bigint | null | undefined, opts: { compact?: boolean } = {}): string {
  if (wad === null || wad === undefined) return UNKNOWN;
  return opts.compact ? formatCompact(wad, 18) : formatFixed(wad, 18, 2);
}

export function collateral(amount: bigint | null | undefined, m: Pick<MarketSnapshot, "quote">, opts: { sign?: "always"; precision?: number } = {}): string {
  if (amount === null || amount === undefined) return UNKNOWN;
  return `${formatFixed(amount, m.quote.decimals, opts.precision ?? 2, { sign: opts.sign })} ${m.quote.symbol}`;
}

export function baseAmount(wad: bigint | null | undefined, symbol: string, precision = 4): string {
  if (wad === null || wad === undefined) return UNKNOWN;
  return `${formatFixed(wad, 18, precision, { sign: wad < 0n ? "auto" : undefined })} ${symbol}`;
}

export function price(wad: bigint | null | undefined): string {
  return formatPrice(wad);
}

export function maxLeverage(m: MarketSnapshot): string {
  return m.risk ? formatLeverageTenths(m.risk.maxLeverageTenths) : UNKNOWN;
}

export function oiUsage(m: MarketSnapshot): string {
  if (!m.risk || m.oiUsdWad === null) return UNKNOWN;
  return `${formatCompact(m.oiUsdWad, 18)} / ${formatCompact(m.risk.maxOiUsdWad, 18)}`;
}

/** Maker capacity in collateral units: committed backing not yet used as margin. */
export function makerCapacity(m: MarketSnapshot): string {
  if (!m.hasPerps) return UNKNOWN;
  return `${formatCompact(m.makerBacking, m.quote.decimals)} ${m.quote.symbol}`;
}

export function percentDistance(from: bigint | null, to: bigint | null): string {
  if (from === null || to === null || from === 0n) return UNKNOWN;
  const diff = ((to - from) * WAD) / from;
  return `${formatFixed(diff * 100n, 18, 2, { sign: "always" })}%`;
}

export function signedCollateral(amount: bigint | null | undefined, decimals: number, symbol: string): string {
  if (amount === null || amount === undefined) return UNKNOWN;
  return `${formatFixed(amount, decimals, 2, { sign: "always" })} ${symbol}`;
}

export function toneOf(x: bigint | null | undefined): "pos" | "neg" | undefined {
  if (x === null || x === undefined || x === 0n) return undefined;
  return x > 0n ? "pos" : "neg";
}
