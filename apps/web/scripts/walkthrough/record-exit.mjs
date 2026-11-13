/**
 * Records the exits and recovery walkthrough on the live site, in one of two takes:
 *   unshield  5 USDG from the private balance back to the connected public wallet.
 *   restore   a fresh browser with no saved state: connect, sign once, and the account rebuilds from chain data.
 *
 *   LIVE_KEY=0x... node apps/web/scripts/walkthrough/record-exit.mjs <unshield|restore> <out-dir>
 */
import { BASE, startRecorder } from "./recorder.mjs";

const [mode, out] = process.argv.slice(2);
const rec = await startRecorder(out, process.env.LIVE_KEY);
const { page, mark } = rec;

async function unshield() {
  await rec.openAccount();
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 10000 }).catch(() => undefined);
  const before = await rec.confirmedOps();
  await page.waitForTimeout(3000);
  mark("overview");
  await page.getByRole("region", { name: "Private balances" }).getByRole("button", { name: "Unshield", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Amount").waitFor({ timeout: 30000 });
  await dialog.getByRole("button", { name: /USDG/ }).first().click().catch(() => undefined);
  await page.waitForTimeout(2000);
  mark("dialog");
  await dialog.getByLabel("Amount").click();
  await page.keyboard.type("5", { delay: 200 });
  await page.waitForTimeout(3500);
  mark("submit");
  await dialog.getByRole("button", { name: "Unshield", exact: true }).click();
  await page.waitForTimeout(1500);
  await rec.waitOperation(before);
  mark("done");
  await page.waitForTimeout(5000);
  mark("end");
}

async function restore() {
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.getByRole("button", { name: "Open account to show it" }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(3000);
  mark("fresh");
  await page.getByRole("button", { name: "Open account to show it" }).click();
  await rec.signIn({ pause: 1500 });
  mark("signed");
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 10000 }).catch(() => undefined);
  await page.getByText(/\d USDG/).first().waitFor({ timeout: 180000 });
  mark("restored");
  await page.waitForTimeout(8000);
  mark("end");
}

try {
  await (mode === "restore" ? restore() : unshield());
} catch (error) {
  await rec.fail(error);
  process.exitCode = 1;
} finally {
  await rec.finish();
}
