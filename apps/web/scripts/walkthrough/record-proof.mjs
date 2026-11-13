/**
 * Records one real trade in a single continuous take for the "not a larp" proof video: a 2 USDG to AMZN private swap
 * on the live site, the Operations panel through confirmation, then the same transaction and the verified Rooq pool
 * contract on the public explorer. Prints the wall-clock start so the edit can show real UTC time.
 *
 *   LIVE_KEY=0x... node apps/web/scripts/walkthrough/record-proof.mjs <out-dir>
 */
import { writeFileSync } from "node:fs";
import { startRecorder } from "./recorder.mjs";

const out = process.argv[2];
const POOL = "0x6b3dEA9d7C3FaCbFd8Eb78c101f0C0fF45648DF5";
const rec = await startRecorder(out, process.env.LIVE_KEY);
const { page, mark } = rec;
try {
  await rec.openAccount();
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 10000 }).catch(() => undefined);
  const before = await rec.confirmedOps();
  await rec.navigate("/app/swap");
  const from = page.getByRole("group", { name: "From" });
  await from.getByRole("button", { name: "USDG" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(2000);
  mark("swap");
  writeFileSync(`${out}/clock.json`, JSON.stringify({ swapAtUtc: new Date().toISOString() }));
  await from.getByRole("button", { name: "USDG" }).click();
  await page.waitForTimeout(800);
  await page.getByRole("group", { name: "To" }).getByRole("button", { name: "AMZN" }).click();
  await page.waitForTimeout(800);
  await page.getByLabel("Amount").click();
  await page.keyboard.type("2", { delay: 200 });
  await page.getByText(/You receive, est\./).waitFor({ timeout: 60000 });
  await page.waitForTimeout(3000);
  mark("submit");
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await page.waitForTimeout(1500);
  await rec.waitOperation(before);
  mark("filled");
  await page.waitForTimeout(3000);
  const link = page.getByRole("dialog").locator('a[href*="/tx/"]').first();
  const href = await link.getAttribute("href", { timeout: 15000 });
  writeFileSync(`${out}/tx.json`, JSON.stringify({ href }));
  console.log(`tx ${href}`);
  await link.hover();
  await page.waitForTimeout(1500);
  mark("explorer");
  await page.goto(href, { waitUntil: "networkidle", timeout: 120000 });
  await page.getByText("Interacted with contract").waitFor({ timeout: 60000 });
  await page.waitForTimeout(9000);
  mark("contract");
  await page.goto(`https://explorer.testnet.chain.robinhood.com/address/${POOL}?tab=contract`, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(9000);
  mark("end");
} catch (error) {
  await rec.fail(error);
  process.exitCode = 1;
} finally {
  await rec.finish();
}
