/**
 * Which private market and pool back which listed market. The market list, header and chart come from the public market
 * data; this names the private market behind each. Testnet sets both maps at deploy; the defaults fit the local stack.
 */
function parse(raw: string | undefined, fallback: string): ReadonlyMap<string, bigint> {
  return new Map((raw ?? fallback).split(",").map((e) => e.trim()).filter(Boolean).map((e) => {
    const [key, id] = e.split(":");
    return [key!, BigInt(id!)] as const;
  }));
}

export const PRIVATE_MARKET_BY_KEY = parse(process.env.NEXT_PUBLIC_PRIVATE_MARKET_MAP, "TSLA:1,AMZN:2");
export const PRIVATE_POOL_BY_KEY = parse(process.env.NEXT_PUBLIC_PRIVATE_POOL_MAP, "TSLA:1");

export function keyForMarket(id: bigint): string | null {
  for (const [k, v] of PRIVATE_MARKET_BY_KEY) if (v === id) return k;
  return null;
}

/** Local fixture tokens stand in for canonical assets. Every screen shows the asset, so one token has one symbol and name. */
export const FIXTURE_DISPLAY: Readonly<Record<string, { readonly symbol: string; readonly name: string }>> = {
  tUSDG: { symbol: "USDG", name: "USDG" },
  tSTKA: { symbol: "TSLA", name: "Tesla" },
  tSTKB: { symbol: "AMZN", name: "Amazon" },
};
