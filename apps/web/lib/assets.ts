import { getAddress, type Address } from "viem";
import { KNOWN_IMPOSTORS, TESTNET_STOCK_TOKENS, TESTNET_USDG, TESTNET_WETH, type VerifiedAsset } from "@rooq/config";
import { CHAIN_CONFIG, DEPLOYMENT } from "./env";

export interface AssetIdentity {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly assetClass: VerifiedAsset["assetClass"];
  readonly verified: boolean;
  readonly isTestFixture: boolean;
  readonly logoUrl: string | null;
  readonly verification: VerifiedAsset["verification"] | null;
  readonly impostorWarning: string | null;
}

const CANONICAL: readonly VerifiedAsset[] = [...TESTNET_STOCK_TOKENS, TESTNET_USDG, TESTNET_WETH];

/**
 * Identity is chain id plus exact address. A canonical entry matches only on chain 46630 and only by
 * address, so a token that copies a ticker can never borrow a verified name or logo.
 */
export function identify(address: Address, fallback: { symbol: string; name: string; decimals: number }): AssetIdentity {
  const addr = getAddress(address);
  const canonical =
    CHAIN_CONFIG.chainId === 46630 ? CANONICAL.find((a) => a.address.toLowerCase() === addr.toLowerCase()) : undefined;
  const impostor = KNOWN_IMPOSTORS.find((a) => a.address.toLowerCase() === addr.toLowerCase());
  if (canonical) {
    return {
      address: addr,
      symbol: canonical.symbol,
      name: canonical.name,
      decimals: canonical.decimals,
      assetClass: canonical.assetClass,
      verified: canonical.assetClass !== "crypto",
      isTestFixture: false,
      logoUrl: canonical.logo?.url ?? null,
      verification: canonical.verification,
      impostorWarning: null,
    };
  }
  const isCollateral = DEPLOYMENT?.collateral.toLowerCase() === addr.toLowerCase();
  const fixtureMarket = DEPLOYMENT?.markets.find((m) => m.base.toLowerCase() === addr.toLowerCase() && m.mode === "mock");
  const isFixture = isCollateral ? DEPLOYMENT?.collateralMode === "mock" : fixtureMarket !== undefined;
  // A local fixture stands in for one canonical asset, named by our own deployment file (never by the
  // token's onchain symbol), so it can show that asset's artwork while staying labelled as a test fixture.
  const standsFor = !isFixture ? undefined : isCollateral ? TESTNET_USDG : TESTNET_STOCK_TOKENS.find((a) => a.symbol === fixtureMarket?.key);
  return {
    address: addr,
    symbol: fallback.symbol,
    name: fallback.name,
    decimals: fallback.decimals,
    assetClass: isFixture ? "test-fixture" : "crypto",
    verified: false,
    isTestFixture: isFixture,
    logoUrl: standsFor?.logo?.url ?? null,
    verification: null,
    impostorWarning: impostor ? `${impostor.claims}: ${impostor.reason}` : null,
  };
}

export function collateralIdentity(): AssetIdentity | null {
  if (!DEPLOYMENT) return null;
  return identify(DEPLOYMENT.collateral, {
    symbol: DEPLOYMENT.collateralSymbol,
    name: DEPLOYMENT.collateralName,
    decimals: DEPLOYMENT.collateralDecimals,
  });
}
