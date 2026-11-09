import { TESTNET_STOCK_TOKENS, type VerifiedAsset } from "@rooq/config";
import { ENV } from "@/lib/env";
import { PRIVATE_MARKET_BY_KEY, PRIVATE_POOL_BY_KEY } from "./markets";
import type { MarketView, PoolView, PrivateView } from "./types";

/** One listed market: its private perps market, its private pool, and the identity every screen shows for it. */
export interface ListedMarket {
  readonly key: string;
  readonly symbol: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly assetClass: VerifiedAsset["assetClass"];
  readonly isTestFixture: boolean;
  readonly market: MarketView | null;
  readonly pool: PoolView | null;
}

function identity(key: string, label: string): Pick<ListedMarket, "symbol" | "name" | "logoUrl" | "assetClass" | "isTestFixture"> {
  const asset = TESTNET_STOCK_TOKENS.find((a) => a.symbol === key);
  const isTestFixture = ENV !== "testnet";
  return { symbol: asset?.symbol ?? label, name: asset?.name ?? label, logoUrl: asset?.logo?.url ?? null, assetClass: isTestFixture ? "test-fixture" : (asset?.assetClass ?? "crypto"), isTestFixture };
}

export function listedMarkets(view: PrivateView): ListedMarket[] {
  const keys = new Set<string>([...PRIVATE_MARKET_BY_KEY.keys(), ...PRIVATE_POOL_BY_KEY.keys()]);
  const out: ListedMarket[] = [];
  for (const key of keys) {
    const id = PRIVATE_MARKET_BY_KEY.get(key);
    const poolId = PRIVATE_POOL_BY_KEY.get(key);
    const market = id === undefined ? null : (view.markets.find((m) => m.id === id) ?? null);
    const pool = poolId === undefined ? null : (view.pools.find((p) => p.id === poolId) ?? null);
    if (market || pool) out.push({ key, market, pool, ...identity(key, key) });
  }
  // Markets created on chain have no mapped asset yet. They list under their id, like any other.
  for (const m of view.markets) {
    if ([...PRIVATE_MARKET_BY_KEY.values()].includes(m.id)) continue;
    out.push({ key: m.id.toString(), market: m, pool: null, ...identity(m.id.toString(), m.label), name: "Created market" });
  }
  return out;
}

export const findListed = (list: readonly ListedMarket[], key: string): ListedMarket | undefined => list.find((m) => m.key === key);
