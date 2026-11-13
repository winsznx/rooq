/**
 * Records the maker walkthrough on the live site: 100 USDG of private backing behind the TSLA perp market, from the
 * form to the live lock under "Available capacity".
 *
 *   LIVE_KEY=0x... node apps/web/scripts/walkthrough/record-maker.mjs <out-dir>
 */
import { startRecorder } from "./recorder.mjs";

const rec = await startRecorder(process.argv[2], process.env.LIVE_KEY);
const { page, mark } = rec;
try {
  await rec.openAccount();
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 10000 }).catch(() => undefined);
  const before = await rec.confirmedOps();
  await rec.navigate("/app/makers");
  const form = page.getByRole("region", { name: "Post backing" });
  await form.getByLabel("Backing").waitFor({ timeout: 60000 });
  await page.waitForTimeout(3000);
  mark("desk");
  await form.getByRole("radio", { name: /TSLA/ }).or(form.getByRole("button", { name: /TSLA/ })).first().click();
  await page.waitForTimeout(900);
  await form.getByLabel("Backing").click();
  await page.keyboard.type("100", { delay: 200 });
  await page.waitForTimeout(1200);
  mark("terms");
  await form.getByLabel("Largest fill").click();
  await page.keyboard.type("0.25", { delay: 200 });
  await page.waitForTimeout(1500);
  await form.getByLabel("Open spread, in bps").click();
  await page.waitForTimeout(1500);
  await form.getByLabel("Close spread you commit to, in bps").click();
  await page.waitForTimeout(3500);
  mark("submit");
  await form.getByRole("button", { name: "Post backing" }).click();
  await page.waitForTimeout(1500);
  await rec.waitOperation(before);
  mark("filled");
  await page.waitForTimeout(3000);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(10000);
  mark("capacity");
  await page.waitForTimeout(2000);
  mark("end");
} catch (error) {
  await rec.fail(error);
  process.exitCode = 1;
} finally {
  await rec.finish();
}
