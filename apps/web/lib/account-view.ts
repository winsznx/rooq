"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { absBig, pnlFloor, scaleFor, spotPoolAbi } from "@rooq/sdk";
import { useAccountSnapshot, useMarketSnapshots, type AccountSnapshot, type MarketSnapshot } from "./chain-data";

const WAD = 10n ** 18n;

/** Everything about one account that is defined. Each value is null when it can't be computed, never zero. */
export interface AccountFigures {
  readonly symbol: string;
  readonly decimals: number;
  /** Wallet collateral plus free margin: the capital that can act right now. */
  readonly available: bigint;
  readonly wallet: bigint;
  readonly freeMargin: bigint;
  readonly lockedMargin: bigint;
  /** Token holdings at each pool's current price. Null if any holding has no pool price. */
  readonly holdingsValue: bigint | null;
  /** Claims on pool reserves at the pool price. Null if any pool could not be read. */
  readonly lpClaimValue: bigint | null;
  /** Notional at the mark. Leverage: never added to any balance. */
  readonly exposure: bigint | null;
  readonly unrealizedPnl: bigint | null;
  readonly holdings: readonly MarketSnapshot[];
  readonly lps: readonly MarketSnapshot[];
  readonly empty: boolean;
}

export function figuresOf(acct: AccountSnapshot, markets: readonly MarketSnapshot[], lpClaim: bigint | null): AccountFigures | null {
  const ref = markets[0];
  if (!ref) return null;
  const holdings = markets.filter((m) => (acct.baseBalances[m.marketId] ?? 0n) > 0n);
  const lps = markets.filter((m) => (acct.lpShares[m.marketId] ?? 0n) > 0n);
  let holdingsValue: bigint | null = 0n;
  for (const m of holdings) {
    if (m.poolPrice === null) {
      holdingsValue = null;
      break;
    }
    holdingsValue += ((acct.baseBalances[m.marketId] ?? 0n) * m.poolPrice) / WAD / scaleFor(m.quote.decimals);
  }
  let exposure: bigint | null = 0n;
  let unrealizedPnl: bigint | null = 0n;
  for (const p of acct.positions) {
    const m = markets.find((x) => x.marketId === p.marketId);
    if (!m || p.mark === null) {
      exposure = null;
      unrealizedPnl = null;
      break;
    }
    const scale = scaleFor(m.quote.decimals);
    exposure = (exposure ?? 0n) + (absBig(p.size) * p.mark) / WAD / scale;
    unrealizedPnl = (unrealizedPnl ?? 0n) + pnlFloor(p.size, p.entryPrice, p.mark, scale);
  }
  const available = acct.walletCollateral + acct.vaultFree;
  return {
    symbol: ref.quote.symbol,
    decimals: ref.quote.decimals,
    available,
    wallet: acct.walletCollateral,
    freeMargin: acct.vaultFree,
    lockedMargin: acct.vaultLocked,
    holdingsValue,
    lpClaimValue: lps.length === 0 ? 0n : lpClaim,
    exposure,
    unrealizedPnl,
    holdings,
    lps,
    empty: available === 0n && acct.vaultLocked === 0n && holdings.length === 0 && lps.length === 0 && acct.positions.length === 0,
  };
}

function useLpClaims(address: Address | undefined, acct: AccountSnapshot | null | undefined, markets: readonly MarketSnapshot[] | undefined) {
  const client = usePublicClient();
  const held = markets && acct ? markets.filter((m) => (acct.lpShares[m.marketId] ?? 0n) > 0n) : [];
  return useQuery({
    queryKey: ["account", "lp-claims", address, held.map((m) => m.marketId).join(","), acct?.blockNumber.toString()],
    enabled: Boolean(client && acct && held.length > 0),
    queryFn: async () => {
      if (!client || !acct) return null;
      const values = await Promise.all(
        held.map(async (m) => {
          const supply = await client.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "totalSupply" });
          if (supply === 0n || m.poolPrice === null) return null;
          const shares = acct.lpShares[m.marketId] ?? 0n;
          const quoteSide = (m.reserveQuote * shares) / supply;
          const baseSide = (m.reserveBase * shares) / supply;
          return quoteSide + (baseSide * m.poolPrice) / WAD / scaleFor(m.quote.decimals);
        }),
      );
      return values.some((v) => v === null) ? null : values.reduce<bigint>((sum, v) => sum + (v ?? 0n), 0n);
    },
  });
}

export type AccountStatus = "disconnected" | "loading" | "unavailable" | "ready";

/** One account view for Overview and Portfolio. Loading, unavailable and empty stay distinct. */
export function useAccountView(address: Address | undefined) {
  const markets = useMarketSnapshots();
  const account = useAccountSnapshot(address);
  const claims = useLpClaims(address, account.data, markets.data);
  const status: AccountStatus = !address ? "disconnected" : account.isLoadingError || markets.isLoadingError ? "unavailable" : account.data && markets.data ? "ready" : "loading";
  const figures = account.data && markets.data ? figuresOf(account.data, markets.data, claims.data ?? null) : null;
  return {
    status,
    markets: markets.data,
    acct: account.data ?? null,
    figures,
    stale: account.isRefetchError,
    lastReadAt: account.dataUpdatedAt,
    retry: () => {
      void account.refetch();
      void markets.refetch();
    },
  };
}
