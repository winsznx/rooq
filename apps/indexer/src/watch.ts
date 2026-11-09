import type { Address, Hex } from "viem";
import type { Deployment } from "@rooq/config";
import type { Queryable } from "./db";
import { ZERO_ADDRESS, isContractKind, lower, type ContractKind, type DecodedEvent } from "./decode";
import type { ContractMeta } from "./meta";
import type { ReducerContext } from "./state";

export interface WatchEntry {
  readonly address: Address;
  readonly kind: ContractKind;
  readonly source: string;
  readonly fromBlock: bigint;
}

/** Core contracts and each recorded market's pool and feed, watched from the deployment block. */
export function deploymentWatchList(dep: Deployment): WatchEntry[] {
  const fromBlock = BigInt(dep.deployBlock);
  const core: [Address, ContractKind][] = [
    [dep.clearingHouse, "clearingHouse"],
    [dep.marginVault, "marginVault"],
    [dep.marketRegistry, "marketRegistry"],
    [dep.marketBackstop, "marketBackstop"],
    [dep.marketPreflight, "marketPreflight"],
    [dep.oracleAdapter, "oracleAdapter"],
    [dep.spotFactory, "spotFactory"],
  ];
  const entries: WatchEntry[] = core.map(([address, kind]) => ({ address: lower(address), kind, source: "deployment", fromBlock }));
  for (const m of dep.markets) {
    entries.push({ address: lower(m.pool), kind: "spotPool", source: `deployment:${m.key}`, fromBlock });
    if (lower(m.feed) !== ZERO_ADDRESS) entries.push({ address: lower(m.feed), kind: "priceFeed", source: `deployment:${m.key}`, fromBlock });
  }
  return entries;
}

/** Contracts announced by watched contracts: pools from the factory and registry, aggregators from the oracle. */
export function discoveredBy(decoded: DecodedEvent, blockNumber: bigint): WatchEntry[] {
  const e = decoded.event;
  if (decoded.contract === "spotFactory" && e.eventName === "PoolCreated") {
    return [{ address: lower(e.args.pool), kind: "spotPool", source: "PoolCreated", fromBlock: blockNumber }];
  }
  if (decoded.contract === "marketRegistry" && e.eventName === "MarketCreated") {
    return [{ address: lower(e.args.pool), kind: "spotPool", source: "MarketCreated", fromBlock: blockNumber }];
  }
  if (decoded.contract === "oracleAdapter" && e.eventName === "FeedRegistered") {
    return [{ address: lower(e.args.aggregator), kind: "priceFeed", source: "FeedRegistered", fromBlock: blockNumber }];
  }
  return [];
}

/** Tokens whose decimals a reducer will need once this event is applied. */
export function tokensReferencedBy(decoded: DecodedEvent): Address[] {
  const e = decoded.event;
  if (decoded.contract === "marketRegistry" && e.eventName === "MarketCreated") return [lower(e.args.base), lower(e.args.quote)];
  if (decoded.contract === "spotFactory" && e.eventName === "PoolCreated") return [lower(e.args.token0), lower(e.args.token1)];
  return [];
}

export class WatchList {
  private readonly entries = new Map<Address, WatchEntry>();

  constructor(initial: readonly WatchEntry[]) {
    for (const e of initial) this.add(e);
  }

  add(entry: WatchEntry): boolean {
    const existing = this.entries.get(entry.address);
    if (existing && existing.fromBlock <= entry.fromBlock) return false;
    this.entries.set(entry.address, existing ? { ...existing, fromBlock: entry.fromBlock } : entry);
    return true;
  }

  has(address: Address): boolean {
    return this.entries.has(address);
  }

  kindOf(address: Address): ContractKind | undefined {
    return this.entries.get(address)?.kind;
  }

  /** Addresses that may have emitted logs at or before `toBlock`. */
  addresses(toBlock: bigint): Address[] {
    return [...this.entries.values()].filter((e) => e.fromBlock <= toBlock).map((e) => e.address).sort();
  }

  feeds(): Address[] {
    return [...this.entries.values()].filter((e) => e.kind === "priceFeed").map((e) => e.address);
  }

  all(): WatchEntry[] {
    return [...this.entries.values()];
  }
}

interface WatchRow {
  readonly address: Address;
  readonly kind: string;
  readonly source: string;
  readonly from_block: bigint;
}

export async function loadDiscovered(q: Queryable, chainId: number): Promise<WatchEntry[]> {
  const rows = await q<WatchRow[]>`SELECT address, kind, source, from_block FROM watched_addresses WHERE chain_id = ${chainId}`;
  return rows.flatMap((r) => (isContractKind(r.kind) ? [{ address: r.address, kind: r.kind, source: r.source, fromBlock: r.from_block }] : []));
}

export async function saveWatched(q: Queryable, chainId: number, entries: readonly WatchEntry[]): Promise<void> {
  for (const e of entries) {
    await q`INSERT INTO watched_addresses (chain_id, address, kind, source, from_block)
      VALUES (${chainId}, ${e.address}, ${e.kind}, ${e.source}, ${e.fromBlock.toString()})
      ON CONFLICT (chain_id, address) DO UPDATE SET from_block = LEAST(watched_addresses.from_block, EXCLUDED.from_block)`;
  }
}

export function configFeedMarkets(dep: Deployment): Map<Address, Hex> {
  return new Map(
    dep.markets.filter((m) => lower(m.feed) !== ZERO_ADDRESS).map((m) => [lower(m.feed), lower(m.marketId)] as const),
  );
}

export function reducerContext(dep: Deployment, meta: ReadonlyMap<Address, ContractMeta>): ReducerContext {
  const tokenDecimals = new Map<Address, number>();
  const feedDecimals = new Map<Address, number>();
  for (const m of meta.values()) (m.kind === "token" ? tokenDecimals : feedDecimals).set(m.address, m.decimals);
  return {
    chainId: dep.chainId,
    vault: lower(dep.marginVault),
    backstop: lower(dep.marketBackstop),
    collateral: lower(dep.collateral),
    collateralDecimals: dep.collateralDecimals,
    configFeedMarkets: configFeedMarkets(dep),
    tokenDecimals,
    feedDecimals,
  };
}

export function deploymentTokens(dep: Deployment): Address[] {
  return [lower(dep.collateral), ...dep.markets.map((m) => lower(m.base))];
}
