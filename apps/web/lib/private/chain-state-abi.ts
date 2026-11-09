import { parseAbi } from "viem";

export const MARKETS_ABI = parseAbi([
  "struct Tier { uint256 imrWad; uint256 mmrWad; uint256 maxOiUsdWad; uint256 takerFeeBps; uint256 penaltyBps; uint256 maxFundingPerHourWad; uint256 maxPairSize; uint256 minBond; }",
  "function tierCount() view returns (uint256)",
  "function tier(uint256 id) view returns (Tier)",
  "function feedTaken(bytes32) view returns (bool)",
  "function createMarket(uint256 tierId, bytes32 feedId, uint256 maxOiUsdWad, uint256 bond) returns (uint256 id)",
  "event MarketCreated(uint256 indexed market, address indexed creator, bytes32 feedId, uint256 tier, uint256 maxOiUsdWad, uint256 bond)",
]);
