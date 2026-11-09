"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address, Hex } from "viem";
import { clearingHouseAbi, marginVaultAbi, marketBackstopAbi } from "@rooq/sdk";
import { DEPLOYMENT, MAKER_URL } from "./env";
import { enumerateMarkets } from "./chain-data";

const FREE = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export interface MakerMarketRow {
  readonly marketId: Hex;
  readonly committed: bigint;
  readonly bond: bigint;
}

export interface MakerAccount {
  readonly wallet: Address;
  readonly vaultFree: bigint;
  readonly locked: bigint;
  readonly quoteSigner: Address;
  readonly nonceFloor: bigint;
  readonly rows: Record<string, MakerMarketRow>;
  readonly committedTotal: bigint;
  readonly bondTotal: bigint;
  /** Margin this wallet has posted as maker inside open pairs: locked minus commitments minus bonds. */
  readonly inPositions: bigint;
  readonly blockNumber: bigint;
}

/** The connected wallet's maker state, read directly from the vault, clearinghouse and backstop. */
export function useMakerAccount(wallet: Address | undefined) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["maker-account", DEPLOYMENT?.chainId, wallet],
    enabled: Boolean(client && DEPLOYMENT && wallet),
    refetchInterval: 5_000,
    queryFn: async (): Promise<MakerAccount | null> => {
      if (!client || !DEPLOYMENT || !wallet) return null;
      const dep = DEPLOYMENT;
      const blockNumber = await client.getBlockNumber();
      const [vaultFree, locked, quoteSigner, nonceFloor] = await Promise.all([
        client.readContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "balanceOf", args: [FREE, wallet], blockNumber }),
        client.readContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "lockedOf", args: [wallet], blockNumber }),
        client.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "quoteSigner", args: [wallet], blockNumber }),
        client.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "nonceFloor", args: [wallet], blockNumber }),
      ]);
      const markets = await enumerateMarkets(client, blockNumber);
      const rows = await Promise.all(
        markets
          .filter((m) => m.feedMode === "relay")
          .map(async (m): Promise<MakerMarketRow> => {
            const domain = await client.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "commitDomain", args: [m.marketId], blockNumber });
            const [committed, bond] = await Promise.all([
              client.readContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "balanceOf", args: [domain, wallet], blockNumber }),
              client.readContract({ address: dep.marketBackstop, abi: marketBackstopAbi, functionName: "bondOf", args: [m.marketId, wallet], blockNumber }),
            ]);
            return { marketId: m.marketId, committed, bond };
          }),
      );
      const committedTotal = rows.reduce((s, r) => s + r.committed, 0n);
      const bondTotal = rows.reduce((s, r) => s + r.bond, 0n);
      const inPositions = locked > committedTotal + bondTotal ? locked - committedTotal - bondTotal : 0n;
      return {
        wallet,
        vaultFree,
        locked,
        quoteSigner,
        nonceFloor,
        rows: Object.fromEntries(rows.map((r) => [r.marketId, r])),
        committedTotal,
        bondTotal,
        inPositions,
        blockNumber,
      };
    },
  });
}

export interface QuoteServiceHealth {
  readonly status: string;
  readonly maker: Address;
  readonly signer: Address;
  readonly chainId: number;
  readonly block: string;
}

/** Health of the quote service the app uses. It is offchain and non-authoritative. */
export function useQuoteServiceHealth() {
  return useQuery({
    queryKey: ["maker-health", MAKER_URL],
    refetchInterval: 10_000,
    retry: 0,
    queryFn: async ({ signal }): Promise<QuoteServiceHealth> => {
      const res = await fetch(`${MAKER_URL}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]), cache: "no-store" });
      if (!res.ok) throw new Error(`quote service ${res.status}`);
      return (await res.json()) as QuoteServiceHealth;
    },
  });
}
