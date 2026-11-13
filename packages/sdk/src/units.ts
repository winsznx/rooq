/** Fixed-point helpers. All money stays in bigint; Number is used only for display formatting. */
export const WAD = 10n ** 18n;
export const BPS = 10_000n;

export function scaleFor(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`unsupported decimals ${decimals}`);
  }
  return 10n ** BigInt(18 - decimals);
}

export function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("division by non-positive");
  if (a === 0n) return 0n;
  if (a < 0n) throw new RangeError("ceilDiv expects a non-negative numerator");
  return (a - 1n) / b + 1n;
}

/** Rounds toward negative infinity, matching RiskMath.floorDiv. */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

/**
 * Parses a user-typed decimal string into fixed-point units without floating point.
 * Returns null for anything that is not a plain non-negative decimal within precision.
 * Commas are accepted only as thousands groups ("1,250.5"). Anything else with a comma, such as a
 * decimal comma ("1,5"), is rejected rather than read as 15: a silent 10x on a position size is worse
 * than asking the user to retype.
 */
export function parseDecimal(input: string, decimals: number): bigint | null {
  const raw = input.trim();
  if (raw.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(raw)) return null;
  const trimmed = raw.replaceAll(",", "");
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** The exact inverse of `parseDecimal` for filling an input: every digit kept, no grouping, no trailing zeros. */
export function toDecimalInput(value: bigint, decimals: number): string {
  if (value < 0n) throw new RangeError("toDecimalInput expects a non-negative value");
  const unit = 10n ** BigInt(decimals);
  const frac = (value % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? (value / unit).toString() : `${value / unit}.${frac}`;
}
