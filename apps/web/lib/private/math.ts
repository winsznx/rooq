/** Page-side estimates, using the same integer rules as packages/private-sdk/src/pairs.ts. The proof is what settles. */
const WAD = 10n ** 18n;
const BPS = 10_000n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a === 0n ? 0n : (a - 1n) / b + 1n);
export const notional = (size: bigint, price: bigint): bigint => ceilDiv(size * price, WAD);
export const margin = (size: bigint, price: bigint, fractionWad: bigint, scale: bigint): bigint => ceilDiv(ceilDiv(notional(size, price) * fractionWad, WAD), scale);
export const fee = (size: bigint, price: bigint, feeBps: bigint, scale: bigint): bigint => ceilDiv(ceilDiv(notional(size, price) * feeBps, BPS), scale);

export function pnl(isShort: boolean, size: bigint, entry: bigint, mark: bigint, scale: bigint): bigint {
  const up = mark >= entry;
  const value = (size * (up ? mark - entry : entry - mark)) / (WAD * scale);
  return up === !isShort ? value : -value;
}

/** Signed from the taker's side: positive means the taker owes funding. */
export function fundingAccrued(isShort: boolean, size: bigint, entryIndex: bigint, index: bigint, scale: bigint): bigint {
  const up = index >= entryIndex;
  const accrued = ceilDiv(size * (up ? index - entryIndex : entryIndex - index), WAD * scale);
  return up === !isShort ? accrued : -accrued;
}

export function slip(price: bigint, isShort: boolean, bps: bigint): bigint {
  return isShort ? (price * (BPS - bps)) / BPS : (price * (BPS + bps)) / BPS;
}

/** The mark at which margin equals the maintenance requirement, as a float. An estimate for display. */
export function liquidationPrice(isShort: boolean, size: bigint, entry: bigint, marginValue: bigint, mmrWad: bigint, scale: bigint): number | null {
  const s = Number(size) / 1e18;
  if (s === 0) return null;
  const e = Number(entry) / 1e18;
  const m = (Number(marginValue) * Number(scale)) / 1e18;
  const mmr = Number(mmrWad) / 1e18;
  const p = isShort ? (m + s * e) / (s * (1 + mmr)) : (s * e - m) / (s * (1 - mmr));
  return p > 0 ? p : null;
}
