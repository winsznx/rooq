/**
 * Records the "start in a minute" walkthrough on the live site: the overview with its test-funds links, connecting a
 * wallet, signing once, and shielding USDG into the private balance with real transactions.
 *
 *   LIVE_KEY=0x... node apps/web/scripts/walkthrough/record-onboarding.mjs <out-dir>
 */
import { BASE, startRecorder } from "./recorder.mjs";

const rec = await startRecorder(process.argv[2], process.env.LIVE_KEY);
const { page, mark } = rec;
try {
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.getByText(/Block \d+/).first().waitFor({ timeout: 120000 });
  await page.waitForTimeout(3000);
  mark("overview");
  await page.getByText("How to start").first().scrollIntoViewIfNeeded();
  await page.getByRole("link", { name: "Robinhood Chain faucet" }).first().hover();
  await page.waitForTimeout(2500);
  await page.getByRole("link", { name: "Paxos faucet" }).first().hover();
  await page.waitForTimeout(3000);
  mark("shield-click");
  await page.getByRole("button", { name: "Shield" }).first().click({ timeout: 30000 });
  mark("sheet");
  await rec.signIn({ pause: 1500 });
  mark("signed");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /USDG/ }).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  mark("dialog");
  await dialog.getByRole("button", { name: /USDG/ }).first().click();
  await page.waitForTimeout(800);
  await dialog.getByLabel("Amount").click();
  await page.keyboard.type("5", { delay: 200 });
  await page.waitForTimeout(1500);
  mark("submit");
  await dialog.getByRole("button", { name: "Shield", exact: true }).click();
  await dialog.getByText(/Shielded\. It enters/).waitFor({ timeout: 180000 });
  mark("shielded");
  await page.waitForTimeout(3000);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(12000);
  mark("balance");
  await page.waitForTimeout(3000);
  mark("end");
} catch (error) {
  await rec.fail(error);
  process.exitCode = 1;
} finally {
  await rec.finish();
}
