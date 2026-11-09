import type { Address, Chain, Hex, PublicClient, Transport } from "viem";
import type { Deployment } from "@rooq/config";
import { PERP_STATUS, clearingHouseAbi, marginVaultAbi, marketBackstopAbi, marketRegistryAbi, mockERC20Abi, spotPoolAbi } from "@rooq/sdk";
import { ZERO_ADDRESS, lower } from "./decode";
import { FEES_DOMAIN, FREE_DOMAIN } from "./domains";
import { ledgerKey, type DerivedState } from "./state";

export interface CheckPair {
  readonly kind: "vault" | "market" | "pair" | "pool" | "ledger";
  readonly key: string;
  readonly field: string;
  readonly derived: bigint | string | boolean;
  readonly onchain: bigint | string | boolean;
}

export interface Mismatch {
  readonly kind: CheckPair["kind"];
  readonly key: string;
  readonly field: string;
  readonly derived: string;
  readonly onchain: string;
}

export interface ReconcileResult {
  readonly blockNumber: bigint;
  readonly ok: boolean;
  readonly checks: number;
  readonly mismatches: readonly Mismatch[];
  readonly counts: Readonly<Record<CheckPair["kind"], number>>;
  /** Collateral held by the vault above its ledger (direct token transfers). Not a failure. */
  readonly vaultSurplus: string;
  readonly truncated: boolean;
}

const norm = (v: bigint | string | boolean): string => (typeof v === "string" ? v.toLowerCase() : String(v));

/** Pure: every pair whose derived and onchain values differ. Strings compare case-insensitively. */
export function diffChecks(pairs: readonly CheckPair[]): Mismatch[] {
  return pairs
    .filter((p) => norm(p.derived) !== norm(p.onchain))
    .map((p) => ({ kind: p.kind, key: p.key, field: p.field, derived: norm(p.derived), onchain: norm(p.onchain) }));
}

export function summarise(result: ReconcileResult): string | null {
  const first = result.mismatches[0];
  if (!first) return null;
  const more = result.mismatches.length > 1 ? ` (+${result.mismatches.length - 1} more)` : "";
  return `reconciliation mismatch at block ${result.blockNumber}: ${first.kind} ${first.key} ${first.field} derived ${first.derived} onchain ${first.onchain}${more}`;
}

export interface ReconcileOptions {
  /** Pairs and free balances changed after this block are always rechecked, even when now closed. */
  readonly sinceBlock: bigint | null;
  readonly maxPairs: number;
  readonly maxLedgerAccounts: number;
}

/**
 * Compares derived state as of `blockNumber` with eth_call reads pinned to that same block:
 * pair size/entry/margins/realised PnL, market status/OI/backing/bad debt/funding index/backstop,
 * pool reserves/LP supply/fees, the vault ledger total and protocol fees, plus conservation
 * (vault ledger <= collateral held).
 */
export async function reconcile(
  client: PublicClient<Transport, Chain>,
  dep: Deployment,
  state: DerivedState,
  blockNumber: bigint,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const at = { blockNumber } as const;
  const pairs: CheckPair[] = [];
  const reads: Promise<void>[] = [];
  const push = (p: CheckPair) => pairs.push(p);

  const vault = state.vaults.get(lower(dep.marginVault));
  let vaultSurplus = 0n;
  reads.push(
    (async () => {
      const [ledger, held] = await Promise.all([
        client.readContract({ ...at, address: dep.marginVault, abi: marginVaultAbi, functionName: "totalLedger" }),
        client.readContract({ ...at, address: dep.collateral, abi: mockERC20Abi, functionName: "balanceOf", args: [dep.marginVault] }),
      ]);
      push({ kind: "vault", key: lower(dep.marginVault), field: "totalLedger", derived: vault?.totalLedger ?? 0n, onchain: ledger });
      push({ kind: "vault", key: lower(dep.marginVault), field: "solvent(totalLedger<=balance)", derived: true, onchain: ledger <= held });
      vaultSurplus = held > ledger ? held - ledger : 0n;
    })(),
  );

  reads.push(
    (async () => {
      const count = await client.readContract({ ...at, address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "marketCount" });
      push({ kind: "market", key: "registry", field: "marketCount", derived: BigInt(state.markets.size), onchain: count });
    })(),
  );

  for (const m of state.markets.values()) {
    const id = m.marketId;
    reads.push(
      (async () => {
        const [onchain, oi, commit, bad, index, insurance, bond] = await Promise.all([
          client.readContract({ ...at, address: dep.marketRegistry, abi: marketRegistryAbi, functionName: "getMarket", args: [id] }),
          client.readContract({ ...at, address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "openInterest", args: [id] }),
          client.readContract({ ...at, address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "commitTotal", args: [id] }),
          client.readContract({ ...at, address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "badDebt", args: [id] }),
          client.readContract({ ...at, address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "fundingIndex", args: [id] }),
          client.readContract({ ...at, address: dep.marketBackstop, abi: marketBackstopAbi, functionName: "insuranceOf", args: [id] }),
          client.readContract({ ...at, address: dep.marketBackstop, abi: marketBackstopAbi, functionName: "creatorBond", args: [id] }),
        ]);
        push({ kind: "market", key: id, field: "perpStatus", derived: m.perpStatus, onchain: PERP_STATUS[onchain.perpStatus] ?? `code ${onchain.perpStatus}` });
        push({ kind: "market", key: id, field: "pool", derived: m.pool, onchain: onchain.pool });
        push({ kind: "market", key: id, field: "longOi", derived: m.longOi, onchain: oi[0] });
        push({ kind: "market", key: id, field: "shortOi", derived: m.shortOi, onchain: oi[1] });
        push({ kind: "market", key: id, field: "commitTotal", derived: m.commitTotal, onchain: commit });
        push({ kind: "market", key: id, field: "badDebt", derived: m.badDebt, onchain: bad });
        push({ kind: "market", key: id, field: "fundingIndex", derived: m.fundingIndex, onchain: index });
        push({ kind: "market", key: id, field: "insurance", derived: m.insurance, onchain: insurance });
        push({ kind: "market", key: id, field: "creatorBond", derived: m.creatorBond, onchain: bond });
      })(),
    );
  }

  const since = opts.sinceBlock;
  const pairCandidates = [...state.positions.values()].filter((p) => p.size !== 0n || since === null || p.updatedBlock > since);
  const truncated = pairCandidates.length > opts.maxPairs;
  for (const p of pairCandidates.slice(0, opts.maxPairs)) {
    const key = `${p.marketId}:${p.taker}`;
    reads.push(
      (async () => {
        const v = await client.readContract({ ...at, address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "getPair", args: [p.marketId, p.taker] });
        push({ kind: "pair", key, field: "size", derived: p.size, onchain: v.size });
        push({ kind: "pair", key, field: "entryPrice", derived: p.entryPrice, onchain: v.entryPrice });
        push({ kind: "pair", key, field: "takerMargin", derived: p.takerMargin, onchain: v.takerMargin });
        push({ kind: "pair", key, field: "makerMargin", derived: p.makerMargin, onchain: v.makerMargin });
        push({ kind: "pair", key, field: "maker", derived: p.maker, onchain: v.maker });
        push({ kind: "pair", key, field: "realizedPnl", derived: p.realizedPnl, onchain: v.realizedPnl });
      })(),
    );
  }

  for (const pool of state.pools.values()) {
    reads.push(
      (async () => {
        const [reserves, supply, fees0, fees1, paused] = await Promise.all([
          client.readContract({ ...at, address: pool.pool, abi: spotPoolAbi, functionName: "getReserves" }),
          client.readContract({ ...at, address: pool.pool, abi: spotPoolAbi, functionName: "totalSupply" }),
          client.readContract({ ...at, address: pool.pool, abi: spotPoolAbi, functionName: "feesAccrued0" }),
          client.readContract({ ...at, address: pool.pool, abi: spotPoolAbi, functionName: "feesAccrued1" }),
          client.readContract({ ...at, address: pool.pool, abi: spotPoolAbi, functionName: "paused" }),
        ]);
        push({ kind: "pool", key: pool.pool, field: "reserve0", derived: pool.reserve0, onchain: reserves[0] });
        push({ kind: "pool", key: pool.pool, field: "reserve1", derived: pool.reserve1, onchain: reserves[1] });
        push({ kind: "pool", key: pool.pool, field: "lpSupply", derived: pool.lpSupply, onchain: supply });
        push({ kind: "pool", key: pool.pool, field: "feesAccrued0", derived: pool.feesAccrued0, onchain: fees0 });
        push({ kind: "pool", key: pool.pool, field: "feesAccrued1", derived: pool.feesAccrued1, onchain: fees1 });
        push({ kind: "pool", key: pool.pool, field: "paused", derived: pool.paused, onchain: paused });
      })(),
    );
  }

  const ledgerChecks: { domain: Hex; account: Address }[] = [{ domain: FEES_DOMAIN, account: ZERO_ADDRESS }];
  for (const b of state.vaultBalances.values()) {
    if (b.domain === FREE_DOMAIN && (since === null || b.updatedBlock > since)) ledgerChecks.push({ domain: b.domain, account: b.account });
  }
  for (const { domain, account } of ledgerChecks.slice(0, opts.maxLedgerAccounts + 1)) {
    reads.push(
      (async () => {
        const [balance, locked] = await Promise.all([
          client.readContract({ ...at, address: dep.marginVault, abi: marginVaultAbi, functionName: "balanceOf", args: [domain, account] }),
          domain === FREE_DOMAIN
            ? client.readContract({ ...at, address: dep.marginVault, abi: marginVaultAbi, functionName: "lockedOf", args: [account] })
            : Promise.resolve(null),
        ]);
        const key = ledgerKey(domain, account);
        push({ kind: "ledger", key, field: "balance", derived: state.vaultBalances.get(key)?.balance ?? 0n, onchain: balance });
        if (locked !== null) {
          let derivedLocked = 0n;
          for (const b of state.vaultBalances.values()) if (b.account === account && b.domain !== FREE_DOMAIN) derivedLocked += b.balance;
          push({ kind: "ledger", key, field: "lockedOf", derived: derivedLocked, onchain: locked });
        }
      })(),
    );
  }

  await Promise.all(reads);
  const mismatches = diffChecks(pairs);
  const counts = { vault: 0, market: 0, pair: 0, pool: 0, ledger: 0 };
  for (const p of pairs) counts[p.kind] += 1;
  return {
    blockNumber,
    ok: mismatches.length === 0,
    checks: pairs.length,
    mismatches,
    counts,
    vaultSurplus: vaultSurplus.toString(),
    truncated: truncated || ledgerChecks.length > opts.maxLedgerAccounts + 1,
  };
}
