/**
 * Display formatting. Inputs are bigint fixed-point; output is a string. Unknown values render as an
 * em dash (U+2014), never as zero. Negative values use a true minus sign (U+2212).
 */
export const UNKNOWN = "—";
const MINUS = "−";

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Formats `value` (with `decimals` fixed-point digits) to `precision` decimal places, rounding half up. */
export function formatFixed(
  value: bigint | null | undefined,
  decimals: number,
  precision: number,
  opts: { sign?: "auto" | "always"; group?: boolean } = {},
): string {
  if (value === null || value === undefined) return UNKNOWN;
  const neg = value < 0n;
  let abs = neg ? -value : value;
  if (precision < decimals) {
    const drop = 10n ** BigInt(decimals - precision);
    abs = (abs + drop / 2n) / drop;
  } else if (precision > decimals) {
    abs *= 10n ** BigInt(precision - decimals);
  }
  const digits = abs.toString().padStart(precision + 1, "0");
  const intPart = digits.slice(0, digits.length - precision) || "0";
  const fracPart = precision > 0 ? digits.slice(digits.length - precision) : "";
  const body = `${opts.group === false ? intPart : groupThousands(intPart)}${fracPart ? `.${fracPart}` : ""}`;
  const isZero = abs === 0n;
  if (neg && !isZero) return `${MINUS}${body}`;
  if (opts.sign === "always" && !isZero) return `+${body}`;
  return body;
}

/** 18-decimal USD price with precision by magnitude, as a trader expects. */
export function formatPrice(wad: bigint | null | undefined): string {
  if (wad === null || wad === undefined) return UNKNOWN;
  const whole = (wad < 0n ? -wad : wad) / 10n ** 18n;
  const precision = whole >= 1000n ? 2 : whole >= 1n ? 2 : 6;
  return formatFixed(wad, 18, precision);
}

/** Collateral amount with its symbol suffix (rule: USDG never takes a dollar sign). */
export function formatCollateral(
  amount: bigint | null | undefined,
  decimals: number,
  symbol: string,
  opts: { sign?: "auto" | "always"; precision?: number } = {},
): string {
  if (amount === null || amount === undefined) return UNKNOWN;
  return `${formatFixed(amount, decimals, opts.precision ?? 2, { sign: opts.sign })} ${symbol}`;
}

/** Compact strip values: 530.06M style, uppercase suffix, two decimals. */
export function formatCompact(value: bigint | null | undefined, decimals: number): string {
  if (value === null || value === undefined) return UNKNOWN;
  const units = [
    { s: "B", e: 9n },
    { s: "M", e: 6n },
    { s: "K", e: 3n },
  ];
  const abs = value < 0n ? -value : value;
  for (const u of units) {
    const threshold = 10n ** (u.e + BigInt(decimals));
    if (abs >= threshold) return `${formatFixed(value, decimals + Number(u.e), 2)}${u.s}`;
  }
  return formatFixed(value, decimals, 2);
}

export function formatBps(bps: bigint | number | null | undefined, precision = 2): string {
  if (bps === null || bps === undefined) return UNKNOWN;
  return `${formatFixed(BigInt(bps) * 10n ** BigInt(precision), precision + 2, precision)}%`;
}

/** Signed percentage from a WAD fraction, e.g. 0.0123e18 -> "+1.23%". */
export function formatPercentWad(wad: bigint | null | undefined, precision = 2): string {
  if (wad === null || wad === undefined) return UNKNOWN;
  return `${formatFixed(wad * 100n, 18, precision, { sign: "always" })}%`;
}

export function formatLeverageTenths(tenths: bigint | number): string {
  return `${formatFixed(BigInt(tenths), 1, 1)}x`;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** mm:ss countdown for quote expiry. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** hh:mm:ss for funding intervals. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNKNOWN;
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
