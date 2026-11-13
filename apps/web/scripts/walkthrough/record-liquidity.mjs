/**
 * Records the private liquidity walkthrough on the live site: one amount into the TSLA pool, "Match pool ratio" for
 * the other side, the two private locks, and the resulting shares under "Your positions".
 *
 *   LIVE_KEY=0x... node apps/web/scripts/walkthrough/record-liquidity.mjs <out-dir>
 */
import { startRecorder } from "./recorder.mjs";

const rec = await startRecorder(process.argv[2], process.env.LIVE_KEY);
const { page, mark } = rec;
try {
  await rec.openAccount();
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 10000 }).catch(() => undefined);
  const before = await rec.confirmedOps();
  await rec.navigate("/app/liquidity");
  const card = page.getByRole("region", { name: /Add to .*\bTSLA\b/ });
  const usdg = card.getByLabel("USDG", { exact: true });
  const tsla = card.getByLabel("TSLA", { exact: true });
  await tsla.waitFor({ timeout: 60000 });
  await page.waitForTimeout(3000);
  mark("pools");
  // "Match pool ratio" fills the second field from the first, so type into whichever comes first.
  const usdgFirst = (await usdg.boundingBox()).y < (await tsla.boundingBox()).y;
  await (usdgFirst ? usdg : tsla).click();
  await page.keyboard.type(usdgFirst ? "40" : "0.1", { delay: 180 });
  await page.waitForTimeout(1200);
  mark("match");
  await card.getByRole("button", { name: "Match pool ratio" }).click();
  await page.waitForTimeout(3500);
  mark("submit");
  await card.getByRole("button", { name: "Add liquidity" }).click();
  await page.waitForTimeout(1500);
  await rec.waitOperation(before);
  mark("filled");
  await page.waitForTimeout(3000);
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Your positions" }).scrollIntoViewIfNeeded();
  await page.getByTestId("lp-row").first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(6000);
  mark("positions");
  await page.waitForTimeout(2000);
  mark("end");
} catch (error) {
  await rec.fail(error);
  process.exitCode = 1;
} finally {
  await rec.finish();
}
