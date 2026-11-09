import type { Address } from "./types";

/**
 * Canonical assets on Robinhood Chain testnet (46630).
 *
 * Every entry records how its identity was verified on 2026-11-07. Tickers are never unique on this
 * chain (the explorer lists dozens of copycat "TSLA" and "USDG" contracts), so identity is the address
 * plus the provenance below, never the symbol.
 */
export type AssetClass = "stock-token" | "stablecoin" | "crypto" | "test-fixture";

export interface VerifiedAsset {
  readonly chainId: number;
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly assetClass: AssetClass;
  /** Robinhood's onchain `uid()` for Stock Tokens. */
  readonly uid?: `0x${string}`;
  readonly verification: {
    readonly method: string;
    readonly sourceUrl: string;
    readonly verifiedAt: string;
  };
  readonly logo?: {
    /** Path served by the web app from public/logos; files are vendored so no third-party CDN is hit at runtime. */
    readonly url: string;
    /** Fill behind a transparent mark, fixed across themes so white or black marks stay visible. Absent for round token art. */
    readonly plate?: string;
    readonly source: string;
    readonly licenseStatus: string;
  };
  /** Mainnet (4663) deployment of the same issuer asset, used only for logo and price provenance. */
  readonly mainnetCounterpart?: Address;
  readonly isin?: string;
}

const STOCK_FACTORY_TESTNET = "0x2DD5b0Ea7c29006bA9450B9a4f3ADc234409e5Da";
const LOGO_LICENSE =
  "Company trademark, used only to identify the underlying asset on testnet. Brand-use review required before any public launch.";

function stockToken(input: {
  address: Address;
  symbol: string;
  name: string;
  uid: `0x${string}`;
  deployTx: string;
  mainnet: Address;
  isin: string;
  plate: string;
}): VerifiedAsset {
  return {
    chainId: 46630,
    address: input.address,
    symbol: input.symbol,
    name: input.name,
    decimals: 18,
    assetClass: "stock-token",
    uid: input.uid,
    verification: {
      method: `Deployed by StockFactory ${STOCK_FACTORY_TESTNET} (tx ${input.deployTx}); BeaconProxy implementing ERC-8056 uiMultiplier() and uid()`,
      sourceUrl: `https://explorer.testnet.chain.robinhood.com/token/${input.address}`,
      verifiedAt: "2026-11-07",
    },
    logo: {
      url: `/logos/${input.symbol.toLowerCase()}.png`,
      plate: input.plate,
      // Robinhood's rhj/assets logoUrl serves one generic placeholder for every Stock Token (identical
      // bytes for TSLA, AMZN, PLTR, checked 2026-11-07), so it does not identify the asset.
      source: `https://financialmodelingprep.com/image-stock/${input.symbol}.png, checked visually 2026-11-07`,
      licenseStatus: LOGO_LICENSE,
    },
    mainnetCounterpart: input.mainnet,
    isin: input.isin,
  };
}

export const TESTNET_STOCK_TOKENS: readonly VerifiedAsset[] = [
  stockToken({
    address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
    symbol: "TSLA",
    plate: "#FFFFFF",
    name: "Tesla",
    uid: "0x00000000000000000000000000000000aa1fee9afa45465cbc65157b4edf63f5",
    deployTx: "0xee0cc8e1be9ccccd5576141a949f6d85a42802724129bcf5549b6496023382eb",
    mainnet: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    isin: "US88160R1014",
  }),
  stockToken({
    address: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02",
    symbol: "AMZN",
    plate: "#131921",
    name: "Amazon",
    uid: "0x0000000000000000000000000000000099c33a4e234448e99d6c8a5e5dddeda0",
    deployTx: "0x5ad73954e3ad4216d360eeb6ca24ad74bc72a2d41299673c8046fd099faa295c",
    mainnet: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
    isin: "US0231351067",
  }),
  stockToken({
    address: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0",
    symbol: "PLTR",
    plate: "#FFFFFF",
    name: "Palantir Technologies",
    uid: "0x0000000000000000000000000000000052cd6b007b15456ba5fbc3aa605765e0",
    deployTx: "0x88a7d74bee10f6903ec636be98a5ec3ebc3615fd0c3bce943252197f754a446a",
    mainnet: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
    isin: "US69608A1088",
  }),
  stockToken({
    address: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93",
    symbol: "NFLX",
    plate: "#FFFFFF",
    name: "Netflix",
    uid: "0x0000000000000000000000000000000041de1e6ae0f4cd3825f77b5a4a3cc784",
    deployTx: "0x99b281dc869f6bdd2bac85cadc6197995d0415cb5fe5b9b80dfc7d6110886af8",
    mainnet: "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8",
    isin: "US64110L1061",
  }),
  stockToken({
    address: "0x71178BAc73cBeb415514eB542a8995b82669778d",
    symbol: "AMD",
    plate: "#FFFFFF",
    name: "AMD",
    uid: "0x00000000000000000000000000000000958cc238f7a04144bf5eb07da3d3734e",
    deployTx: "0x809273a21771b188b1952cdfe31a228f88e245d976229b4965206cd999022ba3",
    mainnet: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
    isin: "US0079031078",
  }),
];

export const TESTNET_USDG: VerifiedAsset = {
  chainId: 46630,
  address: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
  symbol: "USDG",
  name: "Global Dollar (testnet)",
  decimals: 6,
  assetClass: "stablecoin",
  verification: {
    method:
      "Listed by the issuer as 'Robinhood Testnet' USDG; ERC-1967 proxy, name() = 'Global Dollar', decimals() = 6. Supply control 0x4549bb98c667aAb626627C118102c28065E8f54C.",
    sourceUrl: "https://docs.paxos.com/guides/stablecoin/usdg/testnet",
    verifiedAt: "2026-11-07",
  },
  logo: {
    url: "/logos/usdg.png",
    source: "https://coin-images.coingecko.com/coins/images/51281/large/GDN_USDG_Token_200x200.png, the CoinGecko listing for Global Dollar (USDG), homepage globaldollar.com, checked 2026-11-07",
    licenseStatus: "Issuer token artwork. Brand-use review required before any public launch.",
  },
};

export const TESTNET_WETH: VerifiedAsset = {
  chainId: 46630,
  address: "0x7943e237c7F95DA44E0301572D358911207852Fa",
  symbol: "WETH",
  name: "Wrapped Ether",
  decimals: 18,
  assetClass: "crypto",
  verification: {
    method:
      "Onchain only: contract code present, symbol() = WETH, decimals() = 18. Not listed on a first-party page that rendered for us; treat as unverified for leverage.",
    sourceUrl: "https://explorer.testnet.chain.robinhood.com/token/0x7943e237c7F95DA44E0301572D358911207852Fa",
    verifiedAt: "2026-11-07",
  },
  logo: {
    url: "/logos/eth.png",
    source: "https://coin-images.coingecko.com/coins/images/279/large/ethereum.png, the CoinGecko listing for Ethereum, checked 2026-11-07",
    licenseStatus: "Ethereum artwork.",
  },
};

/** Addresses that look canonical but are not. Kept so the UI can warn instead of silently trusting them. */
export const KNOWN_IMPOSTORS: readonly { address: Address; claims: string; reason: string }[] = [
  {
    address: "0x102154E70D8485Ff466bab229bE90a763bF33264",
    claims: "Global Dollar / USDG",
    reason: "Not on the issuer's testnet list",
  },
  {
    address: "0x915Ef7c9F9f80a69e3BE47A38EE0Bb47607103ec",
    claims: "USDG",
    reason: "Not on the issuer's testnet list",
  },
  {
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    claims: "WETH",
    reason: "Mainnet (4663) address; no code on testnet 46630",
  },
  {
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    claims: "USDG",
    reason: "Mainnet (4663) address; no code on testnet 46630",
  },
];

/** Plate colour for a vendored logo path, so the emblem can draw transparent marks on a fixed fill. */
export function logoPlate(url: string): string | null {
  return [...TESTNET_STOCK_TOKENS, TESTNET_USDG, TESTNET_WETH].find((a) => a.logo?.url === url)?.logo?.plate ?? null;
}
