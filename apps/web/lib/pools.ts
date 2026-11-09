"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { spotPoolAbi } from "@rooq/sdk";
import { DEPLOYMENT } from "./env";
import { enumerateMarkets } from "./chain-data";

export interface PoolExtras {
  readonly pool: Address;
  readonly token0: Address;
  readonly lpSupply: bigint;
  readonly feesAccrued0: bigint;
  readonly feesAccrued1: bigint;
  readonly paused: boolean;
}

/** LP supply, fee attribution and pause state for every deployed pool, read at one block. */
export function usePoolExtras() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["pool-extras", DEPLOYMENT?.chainId, DEPLOYMENT?.spotFactory],
    enabled: Boolean(client && DEPLOYMENT),
    refetchInterval: 6_000,
    queryFn: async (): Promise<Record<string, PoolExtras>> => {
      if (!client || !DEPLOYMENT) return {};
      const blockNumber = await client.getBlockNumber();
      const markets = await enumerateMarkets(client, blockNumber);
      const rows = await Promise.all(
        markets.map(async (m) => {
          const [token0, lpSupply, feesAccrued0, feesAccrued1, paused] = await Promise.all([
            client.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "token0", blockNumber }),
            client.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "totalSupply", blockNumber }),
            client.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "feesAccrued0", blockNumber }),
            client.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "feesAccrued1", blockNumber }),
            client.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "paused", blockNumber }),
          ]);
          return [m.marketId, { pool: m.pool, token0, lpSupply, feesAccrued0, feesAccrued1, paused }] as const;
        }),
      );
      return Object.fromEntries(rows);
    },
  });
}

/** Share of the pool in basis points; null when supply is unknown or zero. */
export function shareBps(shares: bigint, supply: bigint): bigint | null {
  return supply === 0n ? null : (shares * 10_000n) / supply;
}
