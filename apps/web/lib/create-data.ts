"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { BaseError, ContractFunctionRevertedError, getAddress, isAddress, type Address, type Hex } from "viem";
import { KNOWN_IMPOSTORS } from "@rooq/config";
import { mockERC20Abi, mockPriceFeedAbi, marketRegistryAbi, oracleAdapterAbi } from "@rooq/sdk";
import { DEPLOYMENT } from "./env";
import { identify, type AssetIdentity } from "./assets";

const WAD = 10n ** 18n;
const TIER_NAMES: Record<number, string> = { 1: "A", 2: "B", 3: "C", 4: "S" };
const TIER_LABELS: Record<number, string> = {
  1: "Major asset with an independent feed",
  2: "Liquid smaller asset",
  3: "Verified volatile asset",
  4: "Stock Token, testnet sample feed",
};

export interface TierView {
  readonly id: number;
  readonly name: string;
  readonly label: string;
  readonly imrWad: bigint;
  readonly mmrWad: bigint;
  readonly maxOiUsdWad: bigint;
  readonly takerFeeBps: number;
  readonly liqPenaltyBps: number;
  readonly minMakerBacking: bigint;
  readonly minBond: bigint;
  readonly maxLeverageTenths: number;
  readonly version: number;
}

/** Risk tiers 1 to 4 as stored in MarketRegistry. A creator can only pick one, never edit it. */
export function useTiers() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["tiers", DEPLOYMENT?.marketRegistry],
    enabled: Boolean(client && DEPLOYMENT),
    staleTime: 60_000,
    queryFn: async (): Promise<TierView[]> => {
      if (!client || !DEPLOYMENT) return [];
      const dep = DEPLOYMENT;
      const tiers = await Promise.all(
        [1, 2, 3, 4].map(async (id) => {
          const t = await client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "getTier", args: [id] });
          return { id, t };
        }),
      );
      return tiers
        .filter(({ t }) => t.version !== 0)
        .map(({ id, t }) => ({
          id,
          name: TIER_NAMES[id] ?? String(id),
          label: TIER_LABELS[id] ?? "Risk tier",
          imrWad: t.imrWad,
          mmrWad: t.mmrWad,
          maxOiUsdWad: t.maxOiUsdWad,
          takerFeeBps: t.takerFeeBps,
          liqPenaltyBps: t.liqPenaltyBps,
          minMakerBacking: t.minMakerBacking,
          minBond: t.minBond,
          maxLeverageTenths: t.imrWad === 0n ? 0 : Number((10n * WAD) / t.imrWad),
          version: t.version,
        }));
    },
  });
}

export interface FeedView {
  readonly feedId: Hex;
  readonly aggregator: Address;
  readonly heartbeat: number;
  readonly description: string | null;
  readonly price: bigint | null;
  readonly updatedAt: number | null;
  readonly fresh: boolean;
}

/**
 * Approved feeds bound to exactly this token, discovered from OracleAdapter FeedRegistered events and
 * re-checked live with isApproved. Feed registration is admin-only; creators can only pick from these.
 */
export function useApprovedFeeds(token: Address | null) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["feeds", DEPLOYMENT?.oracleAdapter, token],
    enabled: Boolean(client && DEPLOYMENT && token),
    staleTime: 15_000,
    queryFn: async (): Promise<FeedView[]> => {
      if (!client || !DEPLOYMENT || !token) return [];
      const dep = DEPLOYMENT;
      const events = await client.getContractEvents({
        address: dep.oracleAdapter,
        abi: oracleAdapterAbi,
        eventName: "FeedRegistered",
        args: { asset: token },
        fromBlock: BigInt(dep.deployBlock),
        toBlock: "latest",
      });
      const ids = [...new Map(events.map((e) => [e.args.feedId, e])).values()];
      const views = await Promise.all(
        ids.map(async (e): Promise<FeedView | null> => {
          const feedId = e.args.feedId;
          if (!feedId || !e.args.aggregator) return null;
          const approved = await client.readContract({ address: dep.oracleAdapter, abi: oracleAdapterAbi, functionName: "isApproved", args: [feedId] });
          if (!approved) return null;
          const [price, updatedAt, fresh] = await client.readContract({ address: dep.oracleAdapter, abi: oracleAdapterAbi, functionName: "getPrice", args: [feedId] });
          let description: string | null = null;
          try {
            description = await client.readContract({ address: e.args.aggregator, abi: mockPriceFeedAbi, functionName: "description" });
          } catch (error) {
            console.warn("feed description unreadable", error);
          }
          return {
            feedId,
            aggregator: e.args.aggregator,
            heartbeat: Number(e.args.heartbeat ?? 0),
            description,
            price: price === 0n ? null : price,
            updatedAt: updatedAt === 0n ? null : Number(updatedAt),
            fresh,
          };
        }),
      );
      return views.filter((v): v is FeedView => v !== null);
    },
  });
}

export interface TokenRead {
  readonly address: Address;
  readonly hasCode: boolean;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
  readonly identity: AssetIdentity | null;
  readonly impostor: string | null;
  readonly isCollateral: boolean;
  readonly existingMarketId: Hex | null;
}

/** Reads a candidate token directly from the chain. Names and symbols are informational, never trusted. */
export function useTokenRead(text: string) {
  const client = usePublicClient();
  const valid = isAddress(text.trim(), { strict: false });
  return useQuery({
    queryKey: ["token-read", DEPLOYMENT?.chainId, text.trim().toLowerCase()],
    enabled: Boolean(client && DEPLOYMENT && valid),
    queryFn: async (): Promise<TokenRead | null> => {
      if (!client || !DEPLOYMENT || !valid) return null;
      const dep = DEPLOYMENT;
      const address = getAddress(text.trim());
      const code = await client.getCode({ address });
      const hasCode = Boolean(code && code !== "0x");
      let symbol: string | null = null;
      let name: string | null = null;
      let decimals: number | null = null;
      if (hasCode) {
        const [s, n, d] = await Promise.allSettled([
          client.readContract({ address, abi: mockERC20Abi, functionName: "symbol" }),
          client.readContract({ address, abi: mockERC20Abi, functionName: "name" }),
          client.readContract({ address, abi: mockERC20Abi, functionName: "decimals" }),
        ]);
        symbol = s.status === "fulfilled" ? s.value : null;
        name = n.status === "fulfilled" ? n.value : null;
        decimals = d.status === "fulfilled" ? d.value : null;
      }
      const marketId = await client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "computeMarketId", args: [address, dep.collateral] });
      let existingMarketId: Hex | null = null;
      try {
        await client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "getMarket", args: [marketId] });
        existingMarketId = marketId;
      } catch (error) {
        // UnknownMarket is the expected answer for a new pair; any other failure is a real error.
        const reverted = error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError);
        if (!reverted) throw error;
      }
      const impostor = KNOWN_IMPOSTORS.find((a) => a.address.toLowerCase() === address.toLowerCase());
      return {
        address,
        hasCode,
        symbol,
        name,
        decimals,
        identity: symbol && name && decimals !== null ? identify(address, { symbol, name, decimals }) : null,
        impostor: impostor ? `${impostor.claims}. ${impostor.reason}.` : null,
        isCollateral: address.toLowerCase() === dep.collateral.toLowerCase(),
        existingMarketId,
      };
    },
  });
}
