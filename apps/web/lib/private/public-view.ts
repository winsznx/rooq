import type { Hex } from "viem";
import type { ChainState } from "./chain-state";
import type { PrivateView } from "./types";

/** What a visitor with no open account sees. It needs no keys and no proving engine, so a page shows data before either loads. */
export function buildPublicView(chain: ChainState, error: string | null): PrivateView {
  const dep = chain.deployment!;
  const assets = [...new Set([dep.asset.toLowerCase(), ...chain.pools.flatMap((p) => [p.token0.toLowerCase(), p.token1.toLowerCase()])])];
  return {
    unlocked: false,
    sync: { syncedBlock: chain.syncedBlock, head: chain.head, processed: chain.processed, queueLength: chain.queueLength, root: chain.root, updatedAt: Date.now(), error },
    chainNow: chain.chainNow, health: { readApi: true, relayer: !chain.relayerDown, rpc: true }, tokens: [...chain.tokens.values()], markets: chain.markets, pools: chain.pools, create: chain.create, exitBond: dep.exitBond, pool: dep.pool, relayerFee: chain.relayerFees,
    address: "", balances: assets.map((a) => ({ asset: a as Hex, free: 0n, arriving: 0n, largestSpendable: 0n, noteCount: 0 })), locks: [], positions: [], claims: [], lp: [], activity: [],
  };
}
