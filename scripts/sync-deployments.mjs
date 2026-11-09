// Copies contracts/deployments/<env>.json (+ .markets.json) into packages/config so the app, API,
// indexer and maker all read one source of addresses keyed by environment and chain id.
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "contracts/deployments");
const dst = join(root, "packages/config/src/deployments");
const envs = readdirSync(src).filter((f) => f.endsWith(".json") && !f.endsWith(".markets.json") && !f.includes(".dryrun")).map((f) => f.replace(".json", ""));
const lines = [];
for (const env of envs) {
  const core = JSON.parse(readFileSync(join(src, `${env}.json`), "utf8"));
  const marketsFile = join(src, `${env}.markets.json`);
  const markets = existsSync(marketsFile) ? JSON.parse(readFileSync(marketsFile, "utf8")) : [];
  const cfg = JSON.parse(readFileSync(join(root, "config/deploy", `${env}.json`), "utf8"));
  const enriched = markets.map((m, i) => ({ ...m, ...pick(cfg.markets[i], ["key", "symbol", "name", "mode", "feedMode", "tier", "poolFee", "heartbeat"]) }));
  writeFileSync(join(dst, `${env}.json`), `${JSON.stringify({ ...core, collateralSymbol: cfg.collateral.symbol, collateralName: cfg.collateral.name, collateralDecimals: Number(cfg.collateral.decimals), collateralMode: cfg.collateral.mode, markets: enriched }, null, 2)}\n`);
  lines.push(env);
}
console.log(`synced: ${lines.join(", ") || "none"}`);

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj?.[k]]));
}
