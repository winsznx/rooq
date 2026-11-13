/**
 * Records the private spot walkthrough on the live site: a USDG to TSLA swap from the ticket to the filled balance.
 *
 *   LIVE_KEY=0x... node apps/web/scripts/walkthrough/record-spot.mjs <out-dir>
 */
import { startRecorder } from "./recorder.mjs";

const rec = await startRecorder(process.argv[2], process.env.LIVE_KEY);
const { page, mark } = rec;
try {
  await rec.openAccount();
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 10000 }).catch(() => undefined);
  const before = await rec.confirmedOps();
  await rec.navigate("/app/swap");
  const from = page.getByRole("group", { name: "From" });
  await from.getByRole("button", { name: "USDG" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);
  mark("swap");
  await from.getByRole("button", { name: "USDG" }).click();
  await page.waitForTimeout(900);
  await page.getByRole("group", { name: "To" }).getByRole("button", { name: "TSLA" }).click();
  await page.waitForTimeout(900);
  await page.getByLabel("Amount").click();
  await page.keyboard.type("3", { delay: 200 });
  await page.getByText(/You receive, est\./).waitFor({ timeout: 60000 });
  await page.waitForTimeout(4000);
  mark("quote");
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  mark("submit");
  await page.waitForTimeout(1500);
  await rec.waitOperation(before);
  mark("filled");
  await page.waitForTimeout(3000);
  await page.keyboard.press("Escape");
  await rec.navigate("/app");
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 5000 }).catch(() => undefined);
  await page.getByText(/\d TSLA/).first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(8000);
  mark("balance");
  await page.waitForTimeout(2000);
  mark("end");
} catch (error) {
  await rec.fail(error);
  process.exitCode = 1;
} finally {
  await rec.finish();
}
