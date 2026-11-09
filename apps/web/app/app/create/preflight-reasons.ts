import { copy } from "@rooq/ui";

/** Plain reasons for each MarketPreflight check bit, shown only when the check fails. */
export function missingReason(key: string, collateralSymbol: string): string {
  switch (key) {
    case "baseContract":
      return "This address has no contract code on this network.";
    case "decimals":
      return "Token decimals are missing or above 18.";
    case "collateral":
      return `Perps settle in ${collateralSymbol}. The quote asset must be ${collateralSymbol}.`;
    case "spotFunded":
      return "Add spot liquidity on both sides of the pool.";
    case "feedApproved":
      return `${copy.preflight.sourceMissing} On testnet, feeds are approved by the oracle admin.`;
    case "feedFresh":
      return "The price feed has not updated within its heartbeat. New risk stays blocked until it does.";
    case "riskBounds":
      return "Choose a risk tier within the protocol's global limits.";
    case "makerBacking":
      return copy.preflight.capacityMissing;
    case "bond":
      return copy.preflight.bondMissing;
    case "noBadDebt":
      return "This market has unpaid losses.";
    case "registered":
      return "The perp configuration is registered when the market is created.";
    default:
      return "Requirement not met.";
  }
}
