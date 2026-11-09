/**
 * TEST oracle relay for the transparent reference markets. The private markets have their own,
 * apps/private-services/src/services/price-relay.ts; both read through @rooq/config's ReferencePriceSource.
 *
 * Copies Robinhood's public Stock Token reference price into the market's MockPriceFeed. It is a
 * single-operator relay: every UI surface labels these feeds "Testnet sample".
 *
 * Fail-closed: if the source is halted, unreachable or older than MAX_SOURCE_AGE_SECONDS, the relay
 * writes nothing, so the feed ages past its heartbeat and the contracts block new risk on their own.
 */
import { ReferencePriceSource } from "@rooq/config";
import { mockPriceFeedAbi } from "@rooq/sdk";
import { loadChain, log, walletFor } from "./chain";

const ctx = await loadChain();
const { account, wallet } = walletFor(ctx, "ORACLE_OPERATOR_PRIVATE_KEY");
const INTERVAL_MS = Number(process.env.RELAY_INTERVAL_MS ?? 15_000);
const MAX_SOURCE_AGE_SECONDS = Number(process.env.MAX_SOURCE_AGE_SECONDS ?? 120);
/** Rewrite an unchanged price before the 3600s heartbeat lapses. */
const REFRESH_SECONDS = Number(process.env.RELAY_REFRESH_SECONDS ?? 900);
const MIN_CHANGE_BPS = 1n;

const lastWritten = new Map<string, { answer: bigint; at: number }>();
const source = new ReferencePriceSource(MAX_SOURCE_AGE_SECONDS, Number(process.env.RELAY_MULTIPLIER_TTL_MS ?? 300_000));

/** Strips the local-fixture "m" prefix (mTSLA -> TSLA); canonical symbols pass through. */
function sourceSymbol(symbol: string, mode: string): string {
  return mode === "mock" && symbol.startsWith("m") ? symbol.slice(1) : symbol;
}

async function tick(): Promise<void> {
  await source.refreshMultipliers();
  for (const market of ctx.deployment.markets) {
    if (market.feedMode !== "relay") continue;
    const symbol = sourceSymbol(market.symbol, market.mode);
    try {
      const q = await source.quote(symbol);
      if (q.status !== "ok") {
        log("relay", q.status === "stale" ? "skip_stale_source" : `skip_${q.status}`, q.status === "stale" ? { symbol, ageSeconds: q.ageSeconds } : { symbol });
        continue;
      }
      const answer = q.answer8;
      const prev = lastWritten.get(market.feed);
      const changed = !prev || (answer > prev.answer ? answer - prev.answer : prev.answer - answer) * 10_000n >= prev.answer * MIN_CHANGE_BPS;
      const due = !prev || Date.now() - prev.at > REFRESH_SECONDS * 1000;
      if (!changed && !due) continue;
      const hash = await wallet.writeContract({
        address: market.feed,
        abi: mockPriceFeedAbi,
        functionName: "setAnswer",
        args: [answer],
        account,
        chain: ctx.chain,
      });
      await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
      lastWritten.set(market.feed, { answer, at: Date.now() });
      log("relay", "price_written", { symbol, answer, bid: q.bid, ask: q.ask, multiplier: q.multiplier, sourceAt: q.sourceAt, tx: hash });
    } catch (error) {
      log("relay", "error", { symbol, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

log("relay", "started", { operator: account.address, env: ctx.env, intervalMs: INTERVAL_MS });
await tick();
setInterval(() => {
  tick().catch((error: unknown) => log("relay", "tick_failed", { error: String(error) }));
}, INTERVAL_MS);
