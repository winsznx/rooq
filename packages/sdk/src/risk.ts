import { BPS, WAD, absBig, ceilDiv, floorDiv } from "./units";

/**
 * TypeScript mirror of contracts/src/lib/RiskMath.sol for previews. The contracts recompute everything
 * at execution; these numbers are estimates shown before signing. test/parity.test.ts checks them
 * against the same vectors as the Rust kernel and the Solidity library.
 */
export function notionalUp(absSize: bigint, price: bigint): bigint {
  return ceilDiv(absSize * price, WAD);
}

export function marginRequirement(absSize: bigint, price: bigint, fractionWad: bigint, scale: bigint): bigint {
  return ceilDiv(ceilDiv(notionalUp(absSize, price) * fractionWad, WAD), scale);
}

export function fee(absSize: bigint, price: bigint, feeBps: bigint, scale: bigint): bigint {
  return ceilDiv(ceilDiv(notionalUp(absSize, price) * feeBps, BPS), scale);
}

export function pnlTrunc(size: bigint, entry: bigint, exit: bigint, scale: bigint): bigint {
  return (size * (exit - entry)) / (WAD * scale);
}

export function pnlFloor(size: bigint, entry: bigint, mark: bigint, scale: bigint): bigint {
  return floorDiv(size * (mark - entry), WAD * scale);
}

export function weightedEntry(absOld: bigint, oldEntry: bigint, absAdd: bigint, addPrice: bigint): bigint {
  return (absOld * oldEntry + absAdd * addPrice) / (absOld + absAdd);
}

export function fundingRatePerSecond(longOi: bigint, shortOi: bigint, maxRatePerHourWad: bigint): bigint {
  const total = longOi + shortOi;
  if (total === 0n) return 0n;
  const maxPerSecond = maxRatePerHourWad / 3600n;
  const skewWad = ((longOi - shortOi) * WAD) / total;
  return (maxPerSecond * skewWad) / WAD;
}

export function fundingIndexDelta(ratePerSecond: bigint, dt: bigint, price: bigint): bigint {
  return (ratePerSecond * dt * price) / WAD;
}

export function fundingOwed(size: bigint, indexDelta: bigint, scale: bigint): bigint {
  const raw = size * indexDelta;
  if (raw === 0n) return 0n;
  const mag = ceilDiv(absBig(raw), WAD * scale);
  return raw > 0n ? mag : -mag;
}

/**
 * Advisory liquidation price for an isolated position, ignoring future funding and fees, using the
 * same formula as PerpLens.estimatedLiquidationPrice. Returns null when no positive price exists.
 */
export function estimatedLiquidationPrice(args: {
  size: bigint;
  entryPrice: bigint;
  marginTokens: bigint;
  mmrWad: bigint;
  scale: bigint;
}): bigint | null {
  const { size, entryPrice, marginTokens, mmrWad, scale } = args;
  if (size === 0n) return null;
  const q = absBig(size);
  const marginWad = marginTokens * scale;
  const qe = (q * entryPrice) / WAD;
  if (size > 0n) {
    if (marginWad >= qe) return null;
    return ((qe - marginWad) * WAD) / ((q * (WAD - mmrWad)) / WAD);
  }
  return ((qe + marginWad) * WAD) / ((q * (WAD + mmrWad)) / WAD);
}

/** Size in base units that a given margin supports at a leverage expressed in tenths (20 = 2.0x). */
export function sizeForMargin(marginTokens: bigint, leverageTenths: bigint, price: bigint, scale: bigint): bigint {
  if (price === 0n) return 0n;
  const notionalWad = (marginTokens * scale * leverageTenths) / 10n;
  return (notionalWad * WAD) / price;
}
