/**
 * Records the private perps walkthrough on the live site at 1920x1080: a real wallet signature, a real proof, a real
 * maker match and a real close. The page renders at 2x (3840x2160) and every changed frame is saved as a near-lossless
 * JPEG with its timestamp, so the edit downscales to a crisp 1080p instead of re-encoding a soft live recording.
 * Writes frames/, frames.txt (an ffmpeg concat list) and marks.json (the second each step happened).
 *
 *   LIVE_KEY=0x... node apps/web/scripts/walkthrough/record-perps.mjs <out-dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/mac/rooq/e2e/node_modules/@playwright/test/index.mjs";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });
const BASE = "https://rooq.trade";
const RPC = "https://rpc.testnet.chain.robinhood.com";
const chain = defineChain({ id: 46630, name: "Robinhood Chain testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = privateKeyToAccount(process.env.LIVE_KEY);
const client = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

async function walletRequest(method, params) {
  if (method === "eth_requestAccounts" || method === "eth_accounts") return [account.address];
  if (method === "eth_chainId") return "0xb626";
  if (method === "wallet_getPermissions" || method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
  if (method === "wallet_switchEthereumChain") return null;
  if (method === "personal_sign") return account.signMessage({ message: { raw: params[0] } });
  if (method === "eth_sendTransaction") {
    const [tx] = params;
    return wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined });
  }
  return client.request({ method, params });
}

// Chrome draws at 2x and the screencast returns full 3840x2160 frames of the normal 1920x1080 layout.
const browser = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2"] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await ctx.exposeFunction("__rooqWallet", async (method, params) => {
  try {
    return await walletRequest(method, params);
  } catch (error) {
    return { __error: String(error).slice(0, 300) };
  }
});
await ctx.addInitScript(`(() => {
  const listeners = {};
  window.ethereum = {
    request: ({ method, params }) => window.__rooqWallet(method, params ?? []).then((r) => {
      if (r && r.__error) throw Object.assign(new Error(r.__error), { code: -32000 });
      return r;
    }),
    on: (e, f) => { (listeners[e] ??= []).push(f); },
    removeListener: (e, f) => { listeners[e] = (listeners[e] ?? []).filter((x) => x !== f); },
  };
})();`);
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error" || /proved in|proof/i.test(m.text())) console.log(`   console ${m.type()}: ${m.text().slice(0, 200)}`);
});
mkdirSync(`${OUT}/frames`, { recursive: true });
const frames = [];
const cdp = await ctx.newCDPSession(page);
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  const name = `frames/${String(frames.length).padStart(6, "0")}.jpg`;
  writeFileSync(`${OUT}/${name}`, Buffer.from(data, "base64"));
  frames.push({ name, t: metadata.timestamp });
  await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 96, maxWidth: 3840, maxHeight: 2160, everyNthFrame: 1 });
const t0 = Date.now();
const marks = {};
const mark = (name) => {
  marks[name] = (Date.now() - t0) / 1000;
  console.log(`${name} ${marks[name].toFixed(2)}`);
};
const navigate = async (path) => {
  await page.evaluate((p) => window.next.router.push(p), path);
  await page.waitForURL(`**${path.split("?")[0]}**`, { timeout: 60000 });
};

async function signIn() {
  const sheet = page.getByTestId("account-sheet");
  if (!(await sheet.waitFor({ timeout: 10000 }).then(() => true).catch(() => false))) return;
  const connect = sheet.getByRole("button", { name: "Connect wallet" });
  if (await connect.isVisible().catch(() => false)) {
    await connect.click();
    await page.getByTestId("rk-wallet-option-injected").click({ timeout: 20000 });
  }
  await sheet.getByRole("button", { name: /Sign to continue/ }).click({ timeout: 30000 });
  await sheet.waitFor({ state: "detached", timeout: 120000 });
}

try {
  await page.goto(`${BASE}/app/portfolio`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.getByRole("button", { name: "Shield" }).first().click({ timeout: 90000 });
  await signIn();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 10000 }).catch(() => undefined);
  await navigate("/app/trade/TSLA?mode=perps");
  await page.getByLabel("Size").waitFor({ timeout: 60000 });
  await page.waitForTimeout(6000);
  mark("ticket");
  await page.waitForTimeout(2500);
  await page.getByRole("radio", { name: "Short" }).or(page.getByRole("button", { name: "Short", exact: true })).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole("radio", { name: "Long" }).or(page.getByRole("button", { name: "Long", exact: true })).first().click();
  await page.waitForTimeout(900);
  mark("size");
  await page.getByLabel("Size").click();
  await page.keyboard.type("0.05", { delay: 180 });
  await page.waitForTimeout(500);
  await page.getByLabel("Margin").click();
  await page.keyboard.type("12", { delay: 180 });
  await page.waitForTimeout(800);
  mark("details");
  await page.waitForTimeout(4500);
  mark("place");
  await page.getByRole("button", { name: /Place order|Confirm new price/ }).click();
  const confirm = page.getByRole("button", { name: "Confirm new price" });
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) await confirm.click();
  const card = page.getByTestId("position-card").first();
  await card.waitFor({ timeout: 420000 });
  mark("open");
  await page.waitForTimeout(6000);
  mark("close");
  await card.getByRole("button", { name: "Manage" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("dialog").getByRole("tab", { name: "Close" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("dialog").getByRole("button", { name: "Close position" }).click();
  await card.waitFor({ state: "detached", timeout: 420000 }).catch(() => undefined);
  mark("closed");
  await navigate("/app/portfolio");
  await page.waitForTimeout(5000);
  mark("balance");
  await page.waitForTimeout(3000);
  mark("end");
} catch (error) {
  console.log(`RECORD FAILED: ${String(error).slice(0, 400)}`);
  await page.screenshot({ path: `${OUT}/failure.png` }).catch(() => undefined);
  await page.getByRole("button", { name: /Operations/ }).first().click().catch(() => undefined);
  await page.waitForTimeout(800);
  console.log(`operations: ${((await page.getByRole("dialog").innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 600)}`);
  process.exitCode = 1;
} finally {
  await cdp.send("Page.stopScreencast").catch(() => undefined);
  await ctx.close();
  await browser.close();
  // Each frame holds until the next one; marks are re-based on the first frame's clock so they match the video.
  const first = frames[0]?.t ?? t0 / 1000;
  const list = frames.map((f, i) => `file '${f.name}'\nduration ${((frames[i + 1]?.t ?? f.t + 0.5) - f.t).toFixed(4)}`);
  writeFileSync(`${OUT}/frames.txt`, `${list.join("\n")}\nfile '${frames.at(-1)?.name}'\n`);
  const offset = t0 / 1000 - first;
  writeFileSync(`${OUT}/marks.json`, JSON.stringify(Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, +(v + offset).toFixed(3)])), null, 2));
  console.log(`frames ${frames.length}`);
}
