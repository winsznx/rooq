/**
 * Live check on rooq.trade after a deployment: sign in, shield, swap, open a perp, and confirm the position shows the
 * update cooldown. Screenshots go to <out-dir>.
 *
 *   LIVE_KEY=0x... node scripts/walkthrough/smoke-live.mjs <out-dir>
 */
import { BASE, startRecorder } from "./recorder.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: smoke-live.mjs <out-dir>");
const rec = await startRecorder(out, process.env.LIVE_KEY);
const { page, mark } = rec;
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
try {
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.getByText(/Block \d+/).first().waitFor({ timeout: 120000 });
  // SKIP=shield,swap reruns only the later steps on an account that already has a private balance.
  const skip = new Set((process.env.SKIP ?? "").split(","));
  if (skip.has("shield")) await rec.openAccount();
  else {
  await page.getByRole("button", { name: "Shield" }).first().click({ timeout: 30000 });
  await rec.signIn();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /USDG/ }).first().click({ timeout: 60000 });
  await dialog.getByLabel("Amount").fill("60");
  await dialog.getByRole("button", { name: "Shield", exact: true }).click();
  await dialog.getByText(/Shielded\. It enters/).waitFor({ timeout: 240000 });
  mark("shielded");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(20000);
  await shot("1-shielded");
  }

  if (!skip.has("swap")) {
  const before = await rec.confirmedOps();
  await rec.navigate("/app/swap");
  const from = page.getByRole("group", { name: "From" });
  await from.getByRole("button", { name: "USDG" }).click({ timeout: 60000 });
  await page.getByRole("group", { name: "To" }).getByRole("button", { name: "TSLA" }).click();
  await page.getByLabel("Amount").fill("3");
  await page.getByText(/You receive, est\./).waitFor({ timeout: 60000 });
  await shot("2-swap-quote");
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await rec.waitOperation(before);
  mark("swapped");
  await shot("3-swap-filled");
  await page.keyboard.press("Escape");
  }

  await rec.navigate("/app/trade/TSLA?mode=perps");
  const size = page.getByRole("textbox", { name: "Size", exact: true });
  await size.waitFor({ timeout: 60000 });
  await page.getByRole("radio", { name: "Long" }).or(page.getByRole("button", { name: "Long", exact: true })).first().click();
  await size.fill("0.02");
  await page.getByRole("textbox", { name: "Margin", exact: true }).fill("15");
  await page.waitForTimeout(2500);
  await shot("4-perp-ticket");
  await page.getByRole("button", { name: /Place order|Confirm new price/ }).click();
  const confirm = page.getByRole("button", { name: "Confirm new price" });
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) await confirm.click();
  const card = page.getByTestId("position-card").first();
  await card.waitFor({ timeout: 420000 });
  mark("opened");
  await page.waitForTimeout(5000);
  const text = (await card.innerText()).replace(/\s+/g, " ");
  console.log(`position: ${text.slice(0, 300)}`);
  console.log(/Next change possible|Changed recently/i.test(text) ? "cooldown shown on the card" : "COOLDOWN NOT SHOWN on the card");
  await shot("5-perp-open");
} catch (error) {
  console.log(`SMOKE FAILED: ${String(error).slice(0, 400)}`);
  await shot("failure").catch(() => undefined);
  process.exitCode = 1;
} finally {
  await rec.finish();
}
