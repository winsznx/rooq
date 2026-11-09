import { BPS } from "./units";

export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const inWithFee = amountIn * (BPS - feeBps);
  return (inWithFee * reserveOut) / (reserveIn * BPS + inWithFee);
}

export function sqrt(x: bigint): bigint {
  if (x < 2n) return x;
  let z = x;
  let y = (x >> 1n) + (x & 1n);
  while (y < z) {
    z = y;
    y = (x / y + y) >> 1n;
  }
  return z;
}

/** Minimum received after a slippage tolerance in basis points. Rounds down. */
export function minReceived(amountOut: bigint, slippageBps: bigint): bigint {
  return (amountOut * (BPS - slippageBps)) / BPS;
}

/**
 * Price impact in basis points from actual reserves: how much worse the execution price is than the
 * pool's marginal price before the trade. Uses reserves only, never market cap or external prices.
 */
export function priceImpactBps(amountIn: bigint, amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const ideal = (amountIn * reserveOut) / reserveIn;
  if (ideal === 0n) return 0n;
  return ((ideal - amountOut) * BPS) / ideal;
}
