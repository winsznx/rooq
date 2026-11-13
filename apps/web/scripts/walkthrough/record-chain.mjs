/**
 * Records the "what the chain sees" walkthrough: a swap as the account sees it in the app, then the public explorer
 * pages for a shield (wallet, token and amount visible) and for that swap's request (sent by the relayer, no transfer).
 *
 *   LIVE_KEY=0x... SHIELD_TX=0x... SWAP_TX=0x... node apps/web/scripts/walkthrough/record-chain.mjs <out-dir>
 */
import { startRecorder } from "./recorder.mjs";

const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
const rec = await startRecorder(process.argv[2], process.env.LIVE_KEY);
const { page, mark } = rec;

async function explorer(hash, name) {
  await page.goto(`${EXPLORER}/tx/${hash}`, { waitUntil: "networkidle", timeout: 120000 });
  await page.getByText("Interacted with contract").waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);
  mark(name);
  await page.waitForTimeout(10000);
}

try {
  await rec.openAccount();
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 10000 }).catch(() => undefined);
  await page.getByText(/Swapped 3\.0000 USDG for/).first().scrollIntoViewIfNeeded({ timeout: 60000 });
  await page.waitForTimeout(3000);
  mark("recent");
  await page.waitForTimeout(8000);
  await explorer(process.env.SHIELD_TX, "shield");
  await explorer(process.env.SWAP_TX, "swap");
  mark("end");
} catch (error) {
  await rec.fail(error);
  process.exitCode = 1;
} finally {
  await rec.finish();
}
