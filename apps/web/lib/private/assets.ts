import { TESTNET_STOCK_TOKENS, TESTNET_USDG, TESTNET_WETH, type VerifiedAsset } from "@rooq/config";
import { CHAIN_CONFIG } from "@/lib/env";
import { keyForMarket } from "./markets";
import type { TokenInfo } from "./types";

export interface Artwork {
  readonly logoUrl: string | null;
  readonly assetClass: VerifiedAsset["assetClass"];
  readonly label: string;
}

const CANONICAL: readonly VerifiedAsset[] = [...TESTNET_STOCK_TOKENS, TESTNET_USDG, TESTNET_WETH];

/** Testnet matches by exact address, never ticker. Locally a fixture shows the artwork of the asset it stands in for. */
export function tokenArtwork(token: TokenInfo): Artwork {
  if (CHAIN_CONFIG.chainId === 46630) {
    const canonical = CANONICAL.find((a) => a.address.toLowerCase() === token.address.toLowerCase());
    return { logoUrl: canonical?.logo?.url ?? null, assetClass: canonical?.assetClass ?? "crypto", label: token.symbol };
  }
  const standsFor = CANONICAL.find((a) => a.symbol === token.symbol);
  return { logoUrl: standsFor?.logo?.url ?? null, assetClass: "test-fixture", label: token.symbol };
}

export function marketArtwork(id: bigint): Artwork {
  const key = keyForMarket(id);
  const stock = CANONICAL.find((a) => a.symbol === key);
  return { logoUrl: stock?.logo?.url ?? null, assetClass: stock?.assetClass ?? "test-fixture", label: key ?? `Market ${id}` };
}
