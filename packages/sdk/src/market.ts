import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export const MARKET_CONFIG_VERSION = 1;

/** Reproduces MarketRegistry.computeMarketId exactly. */
export function computeMarketId(chainId: number, registry: Address, base: Address, quote: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint32" }],
      [BigInt(chainId), registry, base, quote, MARKET_CONFIG_VERSION],
    ),
  );
}

/** Mirrors Types.PerpStatus. */
export const PERP_STATUS = ["NONE", "REGISTERED", "ACTIVE", "CLOSE_ONLY", "PAUSED", "SETTLEMENT_PENDING", "SETTLED"] as const;
export type PerpStatus = (typeof PERP_STATUS)[number];

export const SPOT_STATUS = ["NONE", "ACTIVE", "PAUSED"] as const;
export type SpotStatus = (typeof SPOT_STATUS)[number];

export const PREFLIGHT_VERDICT = ["READY", "NEEDS_FEED", "NEEDS_BACKING", "BLOCKED"] as const;
export type PreflightVerdict = (typeof PREFLIGHT_VERDICT)[number];

/** MarketPreflight check bits, in display order. */
export const PREFLIGHT_CHECKS = [
  { bit: 1n << 0n, key: "baseContract", label: "Asset is a deployed contract" },
  { bit: 1n << 1n, key: "decimals", label: "Asset decimals readable and at most 18" },
  { bit: 1n << 2n, key: "collateral", label: "Quote asset is the margin collateral" },
  { bit: 1n << 3n, key: "spotFunded", label: "Spot pool holds liquidity on both sides" },
  { bit: 1n << 4n, key: "feedApproved", label: "Approved price feed for this asset" },
  { bit: 1n << 5n, key: "feedFresh", label: "Price feed updated within its heartbeat" },
  { bit: 1n << 6n, key: "riskBounds", label: "Risk tier within global bounds" },
  { bit: 1n << 7n, key: "makerBacking", label: "Maker backing committed" },
  { bit: 1n << 8n, key: "bond", label: "Creator bond posted" },
  { bit: 1n << 9n, key: "noBadDebt", label: "No unpaid market losses" },
  { bit: 1n << 10n, key: "registered", label: "Perp configuration registered" },
] as const;
