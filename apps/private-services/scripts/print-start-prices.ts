/**
 * Prints the start prices for a private testnet deployment as shell exports, one price per token in PRIVACY_PERP_TOKENS.
 * Tickers come from the verified asset registry by address. Fails rather than falling back to a default.
 */
import { ReferencePriceSource, TESTNET_STOCK_TOKENS } from "@rooq/config";

const tokens = (process.env.PRIVACY_PERP_TOKENS ?? "").split(",").filter((t) => t !== "");
if (tokens.length === 0) throw new Error("PRIVACY_PERP_TOKENS is not set");
const source = new ReferencePriceSource(Number(process.env.PRIVACY_START_MAX_AGE_S ?? 3_600), 0);
await source.refreshMultipliers();
const symbols: string[] = [];
const prices: bigint[] = [];
for (const token of tokens) {
  const asset = TESTNET_STOCK_TOKENS.find((a) => a.address.toLowerCase() === token.toLowerCase());
  if (!asset) throw new Error(`${token} is not a verified Stock Token in packages/config`);
  const q = await source.quote(asset.symbol);
  if (q.status !== "ok") throw new Error(`no usable start price for ${asset.symbol}: ${q.status}`);
  symbols.push(asset.symbol);
  prices.push(q.answer8);
  console.error(`start price ${asset.symbol} ${q.answer8} (8 decimals), quoted ${q.sourceAt}`);
}
console.log(`export PRIVACY_PERP_SYMBOLS=${symbols.join(",")} PRIVACY_PERP_PRICES_8=${prices.join(",")}`);
