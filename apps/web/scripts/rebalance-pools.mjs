/**
 * Puts each testnet spot pool back on its perps mark and deepens it, through the live site with real proofs.
 * Reserves are private, so each pool's depth is solved from two public quotes. A pool more than 2% off its mark gets
 * one corrective swap, then every pool gets DEPTH_USDG of liquidity at the mark.
 *
 *   LIVE_KEY=0x... SHIELD="USDG:2500,TSLA:3" DEPTH_USDG=400 DEPTH_BY="NFLX:200" node apps/web/scripts/rebalance-pools.mjs
 */
import { startRecorder } from "./walkthrough/recorder.mjs";

const API = "https://api.rooq.trade";
const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
const POOLS = [
  { id: 1, symbol: "TSLA" },
  { id: 2, symbol: "AMZN" },
  { id: 3, symbol: "PLTR" },
  { id: 4, symbol: "NFLX" },
  { id: 5, symbol: "AMD" },
];
const FEE = 0.997;
const TOLERANCE = 0.02;
const DEPTH_USDG = Number(process.env.DEPTH_USDG ?? 400);
/** Per-pool override, e.g. "TSLA:2500,NFLX:1200". A pool missing here uses DEPTH_USDG; 0 skips the add. */
const DEPTH_BY = Object.fromEntries((process.env.DEPTH_BY ?? "").split(",").filter(Boolean).map((s) => [s.split(":")[0], Number(s.split(":")[1])]));
const SHIELD = (process.env.SHIELD ?? "").split(",").filter(Boolean).map((s) => s.split(":"));

async function quoteUsdgIn(pool, usdg) {
  const res = await fetch(`${API}/v1/spot/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pool: String(pool), secondPool: "0", amountIn: String(Math.round(usdg * 1e6)), assetIn: USDG }) });
  const json = await res.json();
  if (json.amountOut === undefined) throw new Error(`quote pool ${pool}: ${JSON.stringify(json)}`);
  return Number(json.amountOut) / 1e18;
}

/** Constant product: out(a) = a·f·y / (x + a·f). Two quotes a hundred times apart pin down both reserves. */
async function reserves(pool) {
  const [a1, a2] = [0.1, 10];
  const [o1, o2] = [await quoteUsdgIn(pool, a1), await quoteUsdgIn(pool, a2)];
  const r = o2 / o1;
  const x = (FEE * a2 * (1 - r)) / (r - a2 / a1);
  const y = (o2 * (x + a2 * FEE)) / (a2 * FEE);
  return { x, y };
}

async function marks() {
  const { markets: list } = await (await fetch(`${API}/v1/markets`)).json();
  return Object.fromEntries(list.map((m) => [Number(m.market), Number(BigInt(m.mark) / 10n ** 12n) / 1e6]));
}

const rec = await startRecorder(null, process.env.LIVE_KEY);
const { page } = rec;
const fixed = (n, d) => n.toFixed(d).replace(/\.?0+$/, "");

async function shield(symbol, amount) {
  await rec.navigate("/app");
  await page.getByRole("button", { name: "Shield" }).first().click({ timeout: 60000 });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: new RegExp(symbol) }).first().click({ timeout: 30000 });
  await dialog.getByLabel("Amount").fill(amount);
  await dialog.getByRole("button", { name: "Shield", exact: true }).click();
  await dialog.getByText(/Shielded\. It enters/).waitFor({ timeout: 240000 });
  await page.keyboard.press("Escape");
  console.log(`shielded ${amount} ${symbol}`);
}

async function swap(from, to, amount) {
  const before = await rec.confirmedOps();
  await rec.navigate("/app/swap");
  await page.getByRole("group", { name: "From" }).getByRole("button", { name: from }).click({ timeout: 60000 });
  await page.getByRole("group", { name: "To" }).getByRole("button", { name: to }).click();
  await page.getByLabel("Amount").fill(amount);
  await page.getByText(/You receive, est\./).waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await rec.waitOperation(before);
  await page.keyboard.press("Escape");
  console.log(`swapped ${amount} ${from} -> ${to}`);
}

async function addLiquidity(symbol, usdg, stock) {
  const before = await rec.confirmedOps();
  await rec.navigate("/app/liquidity");
  const card = page.getByRole("region", { name: new RegExp(`Add to .*\\b${symbol}\\b`) });
  await card.getByLabel("USDG", { exact: true }).fill(usdg);
  await card.getByLabel(symbol, { exact: true }).fill(stock);
  await card.getByRole("button", { name: "Add liquidity" }).click();
  await rec.waitOperation(before);
  await page.keyboard.press("Escape");
  console.log(`added ${usdg} USDG + ${stock} ${symbol}`);
}

try {
  await rec.openAccount();
  for (const [symbol, amount] of SHIELD) await shield(symbol, amount);
  if (SHIELD.length > 0) await page.waitForTimeout(30000);
  const mark = await marks();
  for (const { id, symbol } of POOLS) {
    const { x, y } = await reserves(id);
    const price = x / y;
    const target = mark[id];
    console.log(`${symbol}: ${fixed(x, 2)} USDG / ${fixed(y, 4)} ${symbol}, price ${fixed(price, 2)}, mark ${fixed(target, 2)}`);
    if (price < target * (1 - TOLERANCE)) await swap("USDG", symbol, fixed((Math.sqrt(x * y * target) - x) / FEE, 2));
    else if (price > target * (1 + TOLERANCE)) await swap(symbol, "USDG", fixed((Math.sqrt((x * y) / target) - y) / FEE, 4));
    const depth = DEPTH_BY[symbol] ?? DEPTH_USDG;
    if (depth > 0) await addLiquidity(symbol, fixed(depth, 2), fixed((depth / target) * 1.02, 4));
    const after = await reserves(id);
    console.log(`${symbol} now ${fixed(after.x, 2)} USDG / ${fixed(after.y, 4)}, price ${fixed(after.x / after.y, 2)}`);
  }
} catch (error) {
  await rec.fail(error);
  process.exitCode = 1;
} finally {
  await rec.finish();
}
