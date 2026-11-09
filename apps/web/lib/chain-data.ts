"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address, Hex } from "viem";
import type { DeployedMarket } from "@rooq/config";
import {
  PERP_STATUS,
  SPOT_STATUS,
  clearingHouseAbi,
  marginVaultAbi,
  marketBackstopAbi,
  marketRegistryAbi,
  mockERC20Abi,
  oracleAdapterAbi,
  perpLensAbi,
  spotPoolAbi,
  type PerpStatus,
  type SpotStatus,
} from "@rooq/sdk";
import { DEPLOYMENT } from "./env";
import { identify, type AssetIdentity } from "./assets";

const FREE = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const WAD = 10n ** 18n;

export interface RiskSnapshot {
  readonly tierId: number;
  readonly imrWad: bigint;
  readonly mmrWad: bigint;
  readonly maxOiUsdWad: bigint;
  readonly takerFeeBps: number;
  readonly liqPenaltyBps: number;
  readonly maxDeviationBps: number;
  readonly maxFundingRatePerHourWad: bigint;
  readonly minMakerBacking: bigint;
  readonly minBond: bigint;
  readonly version: number;
  /** floor(10 / IMR) in tenths: 20 means 2.0x. */
  readonly maxLeverageTenths: number;
}

export interface MarketSnapshot {
  readonly deployed: DeployedMarket;
  readonly marketId: Hex;
  readonly base: AssetIdentity;
  readonly quote: AssetIdentity;
  readonly creator: Address;
  readonly spotStatus: SpotStatus;
  readonly perpStatus: PerpStatus;
  /** ACTIVE with a stale price behaves as close-only for new risk. */
  readonly effectivePerpStatus: PerpStatus;
  readonly risk: RiskSnapshot | null;
  readonly mark: bigint | null;
  readonly markUpdatedAt: number | null;
  readonly markFresh: boolean;
  readonly longOi: bigint;
  readonly shortOi: bigint;
  readonly oiUsdWad: bigint | null;
  readonly makerBacking: bigint;
  readonly badDebt: bigint;
  readonly insurance: bigint;
  readonly creatorBond: bigint;
  readonly fundingRatePerSecondWad: bigint;
  readonly pool: Address;
  readonly poolFeeBps: number;
  /** Pool-level pause; independent of the registry's spot status. Swaps and adds revert, removes work. */
  readonly poolPaused: boolean;
  readonly reserveBase: bigint;
  readonly reserveQuote: bigint;
  /** Marginal pool price in 18-decimal quote units per whole base unit; null when unfunded. */
  readonly poolPrice: bigint | null;
  readonly hasPerps: boolean;
  readonly blockNumber: bigint;
}

function maxLeverageTenths(imrWad: bigint): number {
  return imrWad === 0n ? 0 : Number((10n * WAD) / imrWad);
}

export function useMarketSnapshots() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["markets", DEPLOYMENT?.chainId, DEPLOYMENT?.marketRegistry],
    enabled: Boolean(client && DEPLOYMENT),
    refetchInterval: 4_000,
    queryFn: async (): Promise<MarketSnapshot[]> => {
      if (!client || !DEPLOYMENT) return [];
      const dep = DEPLOYMENT;
      const blockNumber = await client.getBlockNumber();
      const quoteMeta = await readTokenMeta(client, dep.collateral, blockNumber);
      const quote = identify(dep.collateral, quoteMeta);
      const all = await enumerateMarkets(client, blockNumber);
      const settled = await Promise.allSettled(
        all.map(async (m): Promise<MarketSnapshot> => {
          const [market, oi, backing, badDebt, insurance, bond, reserves, token0, poolPaused, baseMeta] = await Promise.all([
            client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "getMarket", args: [m.marketId], blockNumber }),
            client.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "openInterest", args: [m.marketId], blockNumber }),
            client.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "commitTotal", args: [m.marketId], blockNumber }),
            client.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "badDebt", args: [m.marketId], blockNumber }),
            client.readContract({ address: dep.marketBackstop, abi: marketBackstopAbi, functionName: "insuranceOf", args: [m.marketId], blockNumber }),
            client.readContract({ address: dep.marketBackstop, abi: marketBackstopAbi, functionName: "creatorBond", args: [m.marketId], blockNumber }),
            client.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "getReserves", blockNumber }),
            client.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "token0", blockNumber }),
            client.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "paused", blockNumber }),
            readTokenMeta(client, m.base, blockNumber),
          ]);
          const hasPerps = m.feedMode === "relay";
          let mark: bigint | null = null;
          let markUpdatedAt: number | null = null;
          let markFresh = false;
          let fundingRate = 0n;
          if (hasPerps) {
            const [p, updatedAt, fresh] = await client.readContract({
              address: dep.oracleAdapter,
              abi: oracleAdapterAbi,
              functionName: "getPrice",
              args: [m.feedId],
              blockNumber,
            });
            mark = p === 0n ? null : p;
            markUpdatedAt = updatedAt === 0n ? null : Number(updatedAt);
            markFresh = fresh;
            fundingRate = await client.readContract({ address: dep.perpLens, abi: perpLensAbi, functionName: "fundingRatePerSecond", args: [m.marketId], blockNumber });
          }
          const base = identify(m.base, baseMeta);
          const baseIs0 = token0.toLowerCase() === m.base.toLowerCase();
          const reserveBase = baseIs0 ? reserves[0] : reserves[1];
          const reserveQuote = baseIs0 ? reserves[1] : reserves[0];
          const quoteScale = 10n ** BigInt(18 - quote.decimals);
          const baseScale = 10n ** BigInt(18 - base.decimals);
          const poolPrice = reserveBase > 0n && reserveQuote > 0n ? (reserveQuote * quoteScale * WAD) / (reserveBase * baseScale) : null;
          const perpStatus = PERP_STATUS[market.perpStatus] ?? "NONE";
          const risk: RiskSnapshot | null =
            market.risk.version === 0
              ? null
              : {
                  tierId: market.tierId,
                  imrWad: market.risk.imrWad,
                  mmrWad: market.risk.mmrWad,
                  maxOiUsdWad: market.risk.maxOiUsdWad,
                  takerFeeBps: market.risk.takerFeeBps,
                  liqPenaltyBps: market.risk.liqPenaltyBps,
                  maxDeviationBps: market.risk.maxDeviationBps,
                  maxFundingRatePerHourWad: market.risk.maxFundingRatePerHourWad,
                  minMakerBacking: market.risk.minMakerBacking,
                  minBond: market.risk.minBond,
                  version: market.risk.version,
                  maxLeverageTenths: maxLeverageTenths(market.risk.imrWad),
                };
          return {
            deployed: m,
            marketId: m.marketId,
            base,
            quote,
            creator: market.creator,
            spotStatus: SPOT_STATUS[market.spotStatus] ?? "NONE",
            perpStatus,
            effectivePerpStatus: perpStatus === "ACTIVE" && !markFresh ? "CLOSE_ONLY" : perpStatus,
            risk,
            mark,
            markUpdatedAt,
            markFresh,
            longOi: oi[0],
            shortOi: oi[1],
            oiUsdWad: mark === null ? null : ((oi[0] + oi[1]) * mark) / WAD,
            makerBacking: backing,
            badDebt,
            insurance,
            creatorBond: bond,
            fundingRatePerSecondWad: fundingRate,
            pool: m.pool,
            poolFeeBps: Number(m.poolFee),
            poolPaused,
            reserveBase,
            reserveQuote,
            poolPrice,
            hasPerps,
            blockNumber,
          };
        }),
      );
      return fulfilled(settled, all, "market snapshot");
    },
  });
}

/**
 * Keeps the readable entries. One market with a hostile or broken token (a reverting symbol(), a pool
 * that is not a pool) must not take every other market off the screen, so failures are dropped and logged.
 */
function fulfilled<T>(results: readonly PromiseSettledResult<T>[], inputs: readonly { readonly marketId: Hex }[], what: string): T[] {
  const out: T[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") out.push(r.value);
    else console.warn(`rooq: skipped unreadable ${what} for market ${inputs[i]?.marketId ?? "?"}`, r.reason);
  });
  return out;
}

export type Client = NonNullable<ReturnType<typeof usePublicClient>>;

/**
 * Every market in the registry, not only the ones created at deployment. Markets created later through
 * the app or by anyone else are described from onchain reads; their tokens are unverified unless they
 * match a canonical address.
 */
export async function enumerateMarkets(client: Client, blockNumber: bigint): Promise<DeployedMarket[]> {
  if (!DEPLOYMENT) return [];
  const dep = DEPLOYMENT;
  const count = await client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "marketCount", blockNumber });
  const ids = await Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "marketIdAt", args: [BigInt(i)], blockNumber }),
    ),
  );
  const known = new Map(dep.markets.map((m) => [m.marketId.toLowerCase(), m]));
  const usedKeys = new Set(dep.markets.map((m) => m.key.toLowerCase()));
  const settled = await Promise.allSettled(
    ids.map(async (id): Promise<DeployedMarket> => {
      const existing = known.get(id.toLowerCase());
      if (existing) return existing;
      const market = await client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "getMarket", args: [id], blockNumber });
      const [symbol, feeBps] = await Promise.all([
        client.readContract({ address: market.base, abi: mockERC20Abi, functionName: "symbol", blockNumber }),
        client.readContract({ address: market.pool, abi: spotPoolAbi, functionName: "feeBps", blockNumber }),
      ]);
      const hasFeed = market.feedId !== "0x0000000000000000000000000000000000000000000000000000000000000000";
      const feed = hasFeed ? await client.readContract({ address: dep.oracleAdapter, abi: oracleAdapterAbi, functionName: "feedConfig", args: [market.feedId], blockNumber }) : null;
      const key = usedKeys.has(symbol.toLowerCase()) ? id : symbol;
      usedKeys.add(key.toLowerCase());
      return {
        key,
        symbol,
        name: symbol,
        mode: "existing",
        feedMode: hasFeed ? "relay" : "none",
        tier: String(market.tierId),
        poolFee: String(feeBps),
        heartbeat: String(feed?.heartbeat ?? 0),
        marketId: id,
        base: market.base,
        pool: market.pool,
        feed: feed?.aggregator ?? "0x0000000000000000000000000000000000000000",
        feedId: market.feedId,
      };
    }),
  );
  return fulfilled(settled, ids.map((marketId) => ({ marketId })), "registry entry");
}

async function readTokenMeta(client: Client, token: Address, blockNumber: bigint) {
  const [symbol, name, decimals] = await Promise.all([
    client.readContract({ address: token, abi: mockERC20Abi, functionName: "symbol", blockNumber }),
    client.readContract({ address: token, abi: mockERC20Abi, functionName: "name", blockNumber }),
    client.readContract({ address: token, abi: mockERC20Abi, functionName: "decimals", blockNumber }),
  ]);
  return { symbol, name, decimals };
}

export interface PositionSnapshot {
  readonly marketId: Hex;
  readonly maker: Address;
  readonly size: bigint;
  readonly entryPrice: bigint;
  readonly takerMargin: bigint;
  readonly makerMargin: bigint;
  readonly realizedPnl: bigint;
  readonly takerEquity: bigint;
  readonly initialMargin: bigint;
  readonly maintenanceMargin: bigint;
  readonly pendingFunding: bigint;
  /** Null when the feed has never reported; PerpLens answers 0 in that case, which is not a price. */
  readonly mark: bigint | null;
  readonly markFresh: boolean;
  readonly liquidatable: boolean;
  readonly estLiquidationPrice: bigint | null;
}

export interface AccountSnapshot {
  readonly address: Address;
  readonly walletCollateral: bigint;
  readonly vaultFree: bigint;
  readonly vaultLocked: bigint;
  readonly vaultAllowance: bigint;
  readonly routerAllowance: bigint;
  readonly baseBalances: Record<string, bigint>;
  readonly lpShares: Record<string, bigint>;
  readonly positions: readonly PositionSnapshot[];
  readonly blockNumber: bigint;
}

export function useAccountSnapshot(address: Address | undefined) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["account", DEPLOYMENT?.chainId, address],
    enabled: Boolean(client && DEPLOYMENT && address),
    refetchInterval: 4_000,
    queryFn: async (): Promise<AccountSnapshot | null> => {
      if (!client || !DEPLOYMENT || !address) return null;
      const dep = DEPLOYMENT;
      const blockNumber = await client.getBlockNumber();
      const [walletCollateral, vaultFree, vaultLocked, vaultAllowance, routerAllowance] = await Promise.all([
        client.readContract({ address: dep.collateral, abi: mockERC20Abi, functionName: "balanceOf", args: [address], blockNumber }),
        client.readContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "balanceOf", args: [FREE, address], blockNumber }),
        client.readContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "lockedOf", args: [address], blockNumber }),
        client.readContract({ address: dep.collateral, abi: mockERC20Abi, functionName: "allowance", args: [address, dep.marginVault], blockNumber }),
        client.readContract({ address: dep.collateral, abi: mockERC20Abi, functionName: "allowance", args: [address, dep.spotRouter], blockNumber }),
      ]);
      const baseBalances: Record<string, bigint> = {};
      const lpShares: Record<string, bigint> = {};
      const positions: PositionSnapshot[] = [];
      const markets = await enumerateMarkets(client, blockNumber);
      const settled = await Promise.allSettled(
        markets.map(async (m) => {
          const [bal, shares, pair] = await Promise.all([
            client.readContract({ address: m.base, abi: mockERC20Abi, functionName: "balanceOf", args: [address], blockNumber }),
            client.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "balanceOf", args: [address], blockNumber }),
            client.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "getPair", args: [m.marketId, address], blockNumber }),
          ]);
          baseBalances[m.marketId] = bal;
          lpShares[m.marketId] = shares;
          if (pair.size !== 0n) {
            const [h, liq] = await Promise.all([
              client.readContract({ address: dep.perpLens, abi: perpLensAbi, functionName: "health", args: [m.marketId, address], blockNumber }),
              client.readContract({ address: dep.perpLens, abi: perpLensAbi, functionName: "estimatedLiquidationPrice", args: [m.marketId, address], blockNumber }),
            ]);
            positions.push({
              marketId: m.marketId,
              maker: pair.maker,
              size: pair.size,
              entryPrice: pair.entryPrice,
              takerMargin: pair.takerMargin,
              makerMargin: pair.makerMargin,
              realizedPnl: pair.realizedPnl,
              takerEquity: h.takerEquity,
              initialMargin: h.initialMargin,
              maintenanceMargin: h.maintenanceMargin,
              pendingFunding: h.pendingFunding,
              mark: h.mark === 0n ? null : h.mark,
              markFresh: h.fresh,
              liquidatable: h.takerLiquidatable,
              estLiquidationPrice: liq === 0n ? null : liq,
            });
          }
        }),
      );
      fulfilled(settled, markets, "account row");
      return { address, walletCollateral, vaultFree, vaultLocked, vaultAllowance, routerAllowance, baseBalances, lpShares, positions, blockNumber };
    },
  });
}

/** Call after any confirmed transaction so every view rereads the chain instead of guessing. */
export function useRefreshChainData() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["markets"] });
    void qc.invalidateQueries({ queryKey: ["account"] });
    void qc.invalidateQueries({ queryKey: ["api"] });
  };
}

export function findMarket(markets: readonly MarketSnapshot[] | undefined, idOrKey: string): MarketSnapshot | undefined {
  const needle = idOrKey.toLowerCase();
  return markets?.find((m) => m.marketId.toLowerCase() === needle || m.deployed.key.toLowerCase() === needle || m.base.symbol.toLowerCase() === needle);
}
