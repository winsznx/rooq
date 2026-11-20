import { UNKNOWN, formatCompact, formatFixed, shortAddress } from "@rooq/sdk";
import type { AssetAmount, TxCategory, WalletSource } from "@rooq/private-sdk/admin";

/** Whole counts stay exact up to five digits, then compact, so a tile never wraps. */
export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  const value = BigInt(Math.round(n));
  return Math.abs(n) < 100_000 ? formatFixed(value, 0, 0) : formatCompact(value, 0);
}

export function eth(wei: string | null | undefined, precision = 4): string {
  if (wei === null || wei === undefined) return UNKNOWN;
  return `${formatFixed(BigInt(wei), 18, precision)} ETH`;
}

function finite(n: number | null | undefined): n is number {
  return n !== null && n !== undefined && Number.isFinite(n);
}

/** A decimal number as fixed-point, through toFixed so large values keep their digits and share the bigint formatters' grouping. */
function fixed(n: number, decimals: number): bigint {
  return BigInt(n.toFixed(decimals).replace(".", ""));
}

/** Dollar values from the service. Compact past a thousand so a tile never wraps; `whole` spells it out to the dollar. */
export function usd(n: number | null | undefined, opts: { whole?: boolean } = {}): string {
  if (!finite(n)) return UNKNOWN;
  const cents = fixed(Math.abs(n), 2);
  const body = opts.whole ? formatFixed(cents, 2, 0) : formatCompact(cents, 2);
  return `${n < 0 && cents > 0n ? "−" : ""}$${body}`;
}

const SIGNIFICANT = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4, useGrouping: false });

/** A token price keeps four significant digits however many zeros lead them. */
export function usdPrice(n: number | null | undefined): string {
  if (!finite(n)) return UNKNOWN;
  if (Math.abs(n) >= 1) return `$${formatFixed(fixed(n, 2), 2, 2)}`;
  return `$${SIGNIFICANT.format(n)}`;
}

/** A token price in ETH, which can sit many zeros below one. */
export function ethPrice(n: number | null | undefined): string {
  if (!finite(n)) return UNKNOWN;
  return `${SIGNIFICANT.format(n)} ETH`;
}

/** ETH the service already scaled to whole units. `eth` takes wei. */
export function ethUnits(n: number | null | undefined, precision = 4): string {
  if (!finite(n)) return UNKNOWN;
  return `${formatFixed(fixed(n, 9), 9, precision)} ETH`;
}

/** A whole-unit token amount, compact past a thousand. */
export function tokenUnits(n: number | null | undefined, symbol: string): string {
  if (!finite(n)) return UNKNOWN;
  return `${formatCompact(fixed(n, 4), 4)} ${symbol}`;
}

/** `pct` is in percent, so 12.5 reads as "+12.5%". */
export function signedPct(pct: number | null | undefined): string {
  if (!finite(pct)) return UNKNOWN;
  return `${formatFixed(fixed(pct, 1), 1, 1, { sign: "always" })}%`;
}

export function sharePct(pct: number | null | undefined): string {
  if (!finite(pct)) return UNKNOWN;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${formatFixed(fixed(pct, 1), 1, 1)}%`;
}

/** Until the service has read a token's decimals the amount is raw base units, and is labeled so rather than scaled wrong. */
export function assetAmount(a: AssetAmount): string {
  if (!a.decimalsKnown) return `${formatCompact(BigInt(a.amount), 0)} base units of ${shortAddress(a.asset)}`;
  return `${formatCompact(BigInt(a.amount), a.decimals)} ${a.symbol}`;
}

export function assetAmounts(list: readonly AssetAmount[]): string {
  return list.length === 0 ? "None" : list.map(assetAmount).join(", ");
}

export function latency(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? UNKNOWN : `${Math.round(ms)} ms`;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/** `processQueue` reads as "Process queue". Action names come from contract function names. */
export function actionLabel(action: string): string {
  const words = action.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const CATEGORY_LABEL: Record<TxCategory, string> = {
  user: "User intent",
  maintenance: "Maintenance",
  oracle: "Oracle writes",
};

export const SOURCE_LABEL: Record<WalletSource, string> = {
  shield: "Shielding",
  unshield: "Receiving an unshield",
  market: "Creating a market",
  direct: "Calling a contract directly",
};
