/**
 * Posts private maker backing on every perps market through the live site, with real proofs. The app's longest
 * backing expiry is 24 hours, so this is meant to be rerun daily.
 *
 *   LIVE_KEY=0x... BACKING_USDG=600 FILL_USD=300 node apps/web/scripts/post-backing.mjs
 */
import { startRecorder } from "./walkthrough/recorder.mjs";

const API = "https://api.rooq.trade";
const MARKETS = [
  { id: 1, symbol: "TSLA" },
  { id: 2, symbol: "AMZN" },
  { id: 3, symbol: "PLTR" },
  { id: 4, symbol: "NFLX" },
  { id: 5, symbol: "AMD" },
];
const BACKING_USDG = process.env.BACKING_USDG ?? "600";
const FILL_USD = Number(process.env.FILL_USD ?? 300);

const { markets } = await (await fetch(`${API}/v1/markets`)).json();
const mark = Object.fromEntries(markets.map((m) => [Number(m.market), Number(BigInt(m.mark) / 10n ** 12n) / 1e6]));

const rec = await startRecorder(null, process.env.LIVE_KEY);
const { page } = rec;
try {
  await rec.openAccount();
  for (const { id, symbol } of MARKETS) {
    const largestFill = (FILL_USD / mark[id]).toFixed(4);
    const before = await rec.confirmedOps();
    await rec.navigate("/app/makers");
    const form = page.getByRole("region", { name: "Post backing" });
    await form.getByLabel("Backing").waitFor({ timeout: 60000 });
    await form.getByRole("radio", { name: new RegExp(symbol) }).or(form.getByRole("button", { name: new RegExp(symbol) })).first().click();
    await form.getByLabel("Backing").fill(BACKING_USDG);
    await form.getByLabel("Largest fill").fill(largestFill);
    await form.getByRole("button", { name: "24 hours" }).click();
    await form.getByRole("button", { name: "Post backing" }).click();
    await rec.waitOperation(before);
    await page.keyboard.press("Escape");
    console.log(`backed ${symbol}: ${BACKING_USDG} USDG, largest fill ${largestFill} (about $${FILL_USD})`);
  }
} catch (error) {
  await rec.fail(error);
  process.exitCode = 1;
} finally {
  await rec.finish();
}
