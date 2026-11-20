/**
 * Opens a private NFLX short on the live site for the find-my-trade round and records the account's own view of it.
 *
 *   LIVE_KEY=0x... node scripts/walkthrough/record-find-my-trade.mjs <out-dir>
 */
import { BASE, startRecorder } from "./recorder.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: record-find-my-trade.mjs <out-dir>");

const rec = await startRecorder(out, process.env.LIVE_KEY);
const { page } = rec;
try {
  await page.goto(`${BASE}/app/portfolio`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.getByRole("button", { name: "Shield" }).first().click({ timeout: 90000 });
  await rec.signIn();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 10000 }).catch(() => undefined);
  await rec.navigate("/app/trade/NFLX?mode=perps");
  await page.getByRole("textbox", { name: "Size", exact: true }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(5000);
  rec.mark("ticket");
  await page.getByRole("radio", { name: "Short" }).or(page.getByRole("button", { name: "Short", exact: true })).first().click();
  await page.waitForTimeout(900);
  await page.getByRole("textbox", { name: "Size", exact: true }).click();
  await page.keyboard.type(process.env.SIZE ?? "0.05", { delay: 160 });
  await page.getByRole("textbox", { name: "Margin", exact: true }).click();
  await page.keyboard.type(process.env.MARGIN ?? "25", { delay: 160 });
  await page.waitForTimeout(2500);
  rec.mark("place");
  await page.getByRole("button", { name: /Place order|Confirm new price/ }).click();
  const confirm = page.getByRole("button", { name: "Confirm new price" });
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) await confirm.click();
  const card = page.getByTestId("position-card").first();
  await card.waitFor({ timeout: 420000 });
  rec.mark("open");
  console.log(`position: ${(await card.innerText()).replace(/\s+/g, " ").slice(0, 400)}`);
  await page.waitForTimeout(8000);
  rec.mark("end");
} catch (error) {
  console.log(`RECORD FAILED: ${String(error).slice(0, 400)}`);
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await rec.finish();
}
