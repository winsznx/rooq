/**
 * Records the transaction inspector on the live site: a public swap on another app, then a Rooq swap. The inspector
 * needs no wallet, so a fresh throwaway key with no funds stands in for the recorder's wallet.
 *
 *   node scripts/walkthrough/record-inspect.mjs <out-dir>
 */
import { generatePrivateKey } from "viem/accounts";
import { BASE, startRecorder } from "./recorder.mjs";

const PUBLIC_SWAP = "0x9c2df19984b4e36a71401026b29ff697759e15dfca331a8243390c64b0d8d0f7";
const ROOQ_SWAP = "0x86a4421bae76f8e6cb5ec4ae3b9d7e96b1ed60bd8becc48dc3689072a22a9552";
const out = process.argv[2];
if (!out) throw new Error("usage: record-inspect.mjs <out-dir>");

const rec = await startRecorder(out, generatePrivateKey());
const { page } = rec;

async function inspect(hash, mark) {
  const input = page.getByPlaceholder("0x…");
  await input.click();
  await input.fill("");
  await page.keyboard.type(hash, { delay: 16 });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await page.getByText(/On the public chain|Everything here is public/).first().waitFor({ timeout: 60000 });
  rec.mark(mark);
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const target = document.querySelector("dl");
    if (target) window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 140, behavior: "smooth" });
  });
}

await page.goto(`${BASE}/inspect`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
rec.mark("open");
await inspect(PUBLIC_SWAP, "public");
await page.waitForTimeout(5000);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await page.waitForTimeout(1200);
await inspect(ROOQ_SWAP, "rooq");
await page.waitForTimeout(6000);
rec.mark("end");
await rec.finish();
