import { getAddress, type Address, type Hex } from "viem";
import type { Deployment } from "@rooq/config";
import {
  clearingHouseAbi,
  marginVaultAbi,
  marketBackstopAbi,
  marketRegistryAbi,
  mockERC20Abi,
  oracleAdapterAbi,
  perpLensAbi,
  spotPoolAbi,
  type LpView,
  type PositionView,
} from "@rooq/sdk";
import type { ChainHandle } from "./chain";
import type { OracleRead, PerpRead, PoolRead, TokenMeta } from "./views";

const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;
const FREE_DOMAIN: Hex = ZERO_BYTES32;
export const MAX_MARKETS = 500;

/** Token symbol/name/decimals are immutable for accepted tokens, so they are read once per process. */
export class TokenCache {
  private readonly cache = new Map<string, Promise<TokenMeta>>();

  constructor(private readonly handle: ChainHandle) {}

  get(address: Address): Promise<TokenMeta> {
    const key = address.toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    const client = this.handle.client;
    const pending = Promise.all([
      client.readContract({ address, abi: mockERC20Abi, functionName: "symbol" }),
      client.readContract({ address, abi: mockERC20Abi, functionName: "name" }),
      client.readContract({ address, abi: mockERC20Abi, functionName: "decimals" }),
    ]).then(([symbol, name, decimals]): TokenMeta => ({ address: getAddress(address), symbol, name, decimals }));
    this.cache.set(key, pending);
    pending.catch(() => this.cache.delete(key));
    return pending;
  }
}

export async function listMarketIds(handle: ChainHandle, dep: Deployment, blockNumber: bigint): Promise<Hex[]> {
  const count = await handle.client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "marketCount", blockNumber });
  const n = Number(count > BigInt(MAX_MARKETS) ? BigInt(MAX_MARKETS) : count);
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      handle.client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "marketIdAt", args: [BigInt(i)], blockNumber }),
    ),
  );
}

export type MarketStruct = Awaited<ReturnType<typeof readMarketStruct>>;

function readMarketStruct(handle: ChainHandle, dep: Deployment, marketId: Hex, blockNumber: bigint) {
  return handle.client.readContract({ address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "getMarket", args: [marketId], blockNumber });
}

export async function readMarketStructs(handle: ChainHandle, dep: Deployment, ids: readonly Hex[], blockNumber: bigint): Promise<MarketStruct[]> {
  return Promise.all(ids.map((id) => readMarketStruct(handle, dep, id, blockNumber)));
}

export async function readOracle(handle: ChainHandle, dep: Deployment, feedId: Hex, blockNumber: bigint): Promise<OracleRead | null> {
  if (feedId.toLowerCase() === ZERO_BYTES32) return null;
  const [price, config] = await Promise.all([
    handle.client.readContract({ address: dep.oracleAdapter, abi: oracleAdapterAbi, functionName: "getPrice", args: [feedId], blockNumber }),
    handle.client.readContract({ address: dep.oracleAdapter, abi: oracleAdapterAbi, functionName: "feedConfig", args: [feedId], blockNumber }),
  ]);
  return { feedId, aggregator: config.aggregator, priceWad: price[0], updatedAt: price[1], fresh: price[2], heartbeat: config.heartbeat };
}

export async function readPool(handle: ChainHandle, pool: Address, blockNumber: bigint): Promise<PoolRead> {
  const c = handle.client;
  const [token0, token1, feeBps, reserves, lpSupply, feesAccrued0, feesAccrued1, paused] = await Promise.all([
    c.readContract({ address: pool, abi: spotPoolAbi, functionName: "token0", blockNumber }),
    c.readContract({ address: pool, abi: spotPoolAbi, functionName: "token1", blockNumber }),
    c.readContract({ address: pool, abi: spotPoolAbi, functionName: "feeBps", blockNumber }),
    c.readContract({ address: pool, abi: spotPoolAbi, functionName: "getReserves", blockNumber }),
    c.readContract({ address: pool, abi: spotPoolAbi, functionName: "totalSupply", blockNumber }),
    c.readContract({ address: pool, abi: spotPoolAbi, functionName: "feesAccrued0", blockNumber }),
    c.readContract({ address: pool, abi: spotPoolAbi, functionName: "feesAccrued1", blockNumber }),
    c.readContract({ address: pool, abi: spotPoolAbi, functionName: "paused", blockNumber }),
  ]);
  return { pool, token0, token1, feeBps, reserve0: reserves[0], reserve1: reserves[1], lpSupply, feesAccrued0, feesAccrued1, paused };
}

export async function readPerp(handle: ChainHandle, dep: Deployment, m: MarketStruct, blockNumber: bigint): Promise<PerpRead> {
  const c = handle.client;
  const id = m.id;
  const [oi, makerBacking, badDebt, fundingRatePerSecondWad, fundingIndex, lastFundingTime, insurance, creatorBond] = await Promise.all([
    c.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "openInterest", args: [id], blockNumber }),
    c.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "commitTotal", args: [id], blockNumber }),
    c.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "badDebt", args: [id], blockNumber }),
    c.readContract({ address: dep.perpLens, abi: perpLensAbi, functionName: "fundingRatePerSecond", args: [id], blockNumber }),
    c.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "fundingIndex", args: [id], blockNumber }),
    c.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "lastFundingTime", args: [id], blockNumber }),
    c.readContract({ address: dep.marketBackstop, abi: marketBackstopAbi, functionName: "insuranceOf", args: [id], blockNumber }),
    c.readContract({ address: dep.marketBackstop, abi: marketBackstopAbi, functionName: "creatorBond", args: [id], blockNumber }),
  ]);
  return {
    status: m.perpStatus,
    tierId: m.tierId,
    risk: m.risk,
    longOi: oi[0],
    shortOi: oi[1],
    makerBacking,
    badDebt,
    fundingRatePerSecondWad,
    fundingIndex,
    lastFundingTime,
    insurance,
    creatorBond,
  };
}

export interface MarketRead {
  readonly market: MarketStruct;
  readonly pool: PoolRead;
  readonly perp: PerpRead;
  readonly oracle: OracleRead | null;
  readonly base: TokenMeta;
  readonly quote: TokenMeta;
}

export async function readMarkets(
  handle: ChainHandle,
  dep: Deployment,
  tokens: TokenCache,
  ids: readonly Hex[],
  blockNumber: bigint,
): Promise<MarketRead[]> {
  const structs = await readMarketStructs(handle, dep, ids, blockNumber);
  return Promise.all(
    structs.map(async (market) => {
      const [pool, perp, oracle, base, quote] = await Promise.all([
        readPool(handle, market.pool, blockNumber),
        readPerp(handle, dep, market, blockNumber),
        readOracle(handle, dep, market.feedId, blockNumber),
        tokens.get(market.base),
        tokens.get(market.quote),
      ]);
      return { market, pool, perp, oracle, base, quote };
    }),
  );
}

export interface PositionRead {
  readonly marketId: Hex;
  readonly pair: { taker: Address; maker: Address; size: bigint; entryPrice: bigint; takerMargin: bigint; makerMargin: bigint; realizedPnl: bigint };
  readonly health: {
    takerEquity: bigint;
    initialMargin: bigint;
    maintenanceMargin: bigint;
    mark: bigint;
    fresh: boolean;
    pendingFunding: bigint;
    takerLiquidatable: boolean;
  };
  readonly liquidationPrice: bigint;
}

export async function readPositions(handle: ChainHandle, dep: Deployment, wallet: Address, marketIds: readonly Hex[], blockNumber: bigint): Promise<PositionRead[]> {
  const c = handle.client;
  const reads = await Promise.all(
    marketIds.map(async (marketId): Promise<PositionRead> => {
      const [pair, health, liquidationPrice] = await Promise.all([
        c.readContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "getPair", args: [marketId, wallet], blockNumber }),
        c.readContract({ address: dep.perpLens, abi: perpLensAbi, functionName: "health", args: [marketId, wallet], blockNumber }),
        c.readContract({ address: dep.perpLens, abi: perpLensAbi, functionName: "estimatedLiquidationPrice", args: [marketId, wallet], blockNumber }),
      ]);
      return { marketId, pair, health, liquidationPrice };
    }),
  );
  return reads.filter((r) => r.pair.size !== 0n);
}

/** Health fields are unknown (null) when the lens had no usable mark, never zero. */
export function positionView(read: PositionRead): PositionView {
  const { pair, health } = read;
  const known = health.mark !== 0n;
  return {
    marketId: read.marketId,
    taker: getAddress(pair.taker),
    maker: getAddress(pair.maker),
    size: pair.size.toString(),
    entryPrice: pair.entryPrice.toString(),
    takerMargin: pair.takerMargin.toString(),
    makerMargin: pair.makerMargin.toString(),
    realizedPnl: pair.realizedPnl.toString(),
    takerEquity: known ? health.takerEquity.toString() : null,
    initialMargin: known ? health.initialMargin.toString() : null,
    maintenanceMargin: known ? health.maintenanceMargin.toString() : null,
    pendingFunding: known ? health.pendingFunding.toString() : null,
    markPrice: known ? health.mark.toString() : null,
    markFresh: health.fresh,
    estLiquidationPrice: read.liquidationPrice === 0n ? null : read.liquidationPrice.toString(),
    liquidatable: health.takerLiquidatable,
  };
}

export async function readLp(handle: ChainHandle, wallet: Address, markets: readonly MarketStruct[], blockNumber: bigint): Promise<LpView[]> {
  const c = handle.client;
  const rows = await Promise.all(
    markets.map(async (m) => {
      const [shares, supply, reserves] = await Promise.all([
        c.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "balanceOf", args: [wallet], blockNumber }),
        c.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "totalSupply", blockNumber }),
        c.readContract({ address: m.pool, abi: spotPoolAbi, functionName: "getReserves", blockNumber }),
      ]);
      return { m, shares, supply, reserves };
    }),
  );
  return rows
    .filter((r) => r.shares > 0n && r.supply > 0n)
    .map(({ m, shares, supply, reserves }) => ({
      marketId: m.id,
      pool: getAddress(m.pool),
      shares: shares.toString(),
      lpSupply: supply.toString(),
      amount0: ((shares * reserves[0]) / supply).toString(),
      amount1: ((shares * reserves[1]) / supply).toString(),
    }));
}

export async function readCollateral(handle: ChainHandle, dep: Deployment, wallet: Address, blockNumber: bigint) {
  const c = handle.client;
  const [walletBalance, vaultFree, vaultLocked] = await Promise.all([
    c.readContract({ address: dep.collateral, abi: mockERC20Abi, functionName: "balanceOf", args: [wallet], blockNumber }),
    c.readContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "balanceOf", args: [FREE_DOMAIN, wallet], blockNumber }),
    c.readContract({ address: dep.marginVault, abi: marginVaultAbi, functionName: "lockedOf", args: [wallet], blockNumber }),
  ]);
  return { walletBalance, vaultFree, vaultLocked };
}

export async function readBalances(handle: ChainHandle, wallet: Address, tokens: readonly Address[], blockNumber: bigint): Promise<Map<string, bigint>> {
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))].map((t) => getAddress(t));
  const balances = await Promise.all(
    unique.map((token) => handle.client.readContract({ address: token, abi: mockERC20Abi, functionName: "balanceOf", args: [wallet], blockNumber })),
  );
  return new Map(unique.map((t, i) => [t.toLowerCase(), balances[i] ?? 0n]));
}
