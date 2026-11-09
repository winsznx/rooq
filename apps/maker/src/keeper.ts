/**
 * Permissionless keeper. Anyone can run it; it only calls functions the contracts already allow anyone
 * to call: liquidate() when PerpLens reports an unhealthy side at a fresh price, and triggerCloseOnly()
 * when a market's feed has gone stale. The contracts recheck everything;
 * a keeper mistake reverts instead of harming an account.
 */
import { parseAbiItem, type Address, type Hex } from "viem";
import { clearingHouseAbi, oracleAdapterAbi, perpLensAbi } from "@rooq/sdk";
import { loadChain, log, walletFor } from "./chain";

const ctx = await loadChain();
const { account, wallet } = walletFor(ctx, "KEEPER_PRIVATE_KEY");
const dep = ctx.deployment;
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 10_000);
/** Public RPCs cap eth_getLogs ranges; scan history in windows below the common 10k-block limit. */
const LOG_RANGE = BigInt(process.env.KEEPER_LOG_RANGE ?? 5_000);
const positionChanged = parseAbiItem(
  "event PositionChanged(bytes32 indexed marketId, address indexed taker, address indexed maker, int256 size, uint256 entryPrice, uint256 takerMargin, uint256 makerMargin)",
);

/** Open pairs reconstructed from events; the chain stays the source of truth via PerpLens reads. */
const open = new Map<string, { marketId: Hex; taker: Address }>();
let fromBlock = BigInt(dep.deployBlock);

async function syncPairs(): Promise<void> {
  const head = await ctx.publicClient.getBlockNumber();
  while (fromBlock <= head) {
    const toBlock = fromBlock + LOG_RANGE - 1n < head ? fromBlock + LOG_RANGE - 1n : head;
    const logs = await ctx.publicClient.getLogs({ address: dep.clearingHouse, event: positionChanged, fromBlock, toBlock });
    for (const l of logs) {
      const key = `${l.args.marketId}:${l.args.taker}`;
      if (l.args.size === 0n) open.delete(key);
      else open.set(key, { marketId: l.args.marketId as Hex, taker: l.args.taker as Address });
    }
    fromBlock = toBlock + 1n;
  }
}

async function submit(label: string, args: readonly unknown[], simulate: () => Promise<{ request: Parameters<typeof wallet.writeContract>[0] }>): Promise<void> {
  try {
    const { request } = await simulate();
    const hash = await wallet.writeContract(request);
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
    log("keeper", label, { args, tx: hash, status: receipt.status, block: receipt.blockNumber });
  } catch (error) {
    log("keeper", `${label}_skipped`, { args, reason: error instanceof Error ? error.message.split("\n")[0] : String(error) });
  }
}

const liquidate = (marketId: Hex, taker: Address) =>
  submit("liquidate", [marketId, taker], () =>
    ctx.publicClient.simulateContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "liquidate", args: [marketId, taker], account }),
  );

const triggerCloseOnly = (marketId: Hex) =>
  submit("triggerCloseOnly", [marketId], () =>
    ctx.publicClient.simulateContract({ address: dep.clearingHouse, abi: clearingHouseAbi, functionName: "triggerCloseOnly", args: [marketId], account }),
  );

async function tick(): Promise<void> {
  await syncPairs();
  for (const { marketId, taker } of open.values()) {
    const h = await ctx.publicClient.readContract({
      address: dep.perpLens,
      abi: perpLensAbi,
      functionName: "health",
      args: [marketId, taker],
    });
    if (h.fresh && (h.takerLiquidatable || h.makerLiquidatable)) await liquidate(marketId, taker);
  }
  for (const m of dep.markets) {
    if (m.feedMode !== "relay") continue;
    const fresh = await ctx.publicClient.readContract({
      address: dep.oracleAdapter,
      abi: oracleAdapterAbi,
      functionName: "isFresh",
      args: [m.feedId],
    });
    if (!fresh) await triggerCloseOnly(m.marketId);
  }
}

log("keeper", "started", { keeper: account.address, env: ctx.env, intervalMs: INTERVAL_MS });
await tick();
setInterval(() => {
  tick().catch((error: unknown) => log("keeper", "tick_failed", { error: String(error) }));
}, INTERVAL_MS);
