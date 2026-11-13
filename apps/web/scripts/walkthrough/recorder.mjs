/**
 * Shared recorder for the product walkthroughs. Drives the live site with a real wallet (the key stays in this Node
 * process), renders at 2x and saves every changed frame as a near-lossless JPEG with its timestamp, so the edit gets
 * crisp 3840x2160 footage. `finish()` writes frames.txt (an ffmpeg concat list) and marks.json (seconds into the video).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/mac/rooq/e2e/node_modules/@playwright/test/index.mjs";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://rpc.testnet.chain.robinhood.com";
export const BASE = "https://rooq.trade";

/** Pass `out = null` to drive the site without capturing, for operations that don't need footage. */
export async function startRecorder(out, key) {
  if (out) mkdirSync(`${out}/frames`, { recursive: true });
  const chain = defineChain({ id: 46630, name: "Robinhood Chain testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const account = privateKeyToAccount(key);
  const client = createPublicClient({ chain, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const browser = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2"] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  // Like a real wallet, accounts stay hidden until the page asks for access, so a fresh visit starts disconnected.
  let granted = false;
  await ctx.exposeFunction("__rooqWallet", async (method, params) => {
    try {
      if (method === "eth_requestAccounts") {
        granted = true;
        return [account.address];
      }
      if (method === "eth_accounts") return granted ? [account.address] : [];
      if (method === "eth_chainId") return "0xb626";
      if (method === "wallet_requestPermissions") {
        granted = true;
        return [{ parentCapability: "eth_accounts" }];
      }
      if (method === "wallet_getPermissions") return granted ? [{ parentCapability: "eth_accounts" }] : [];
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "personal_sign") return await account.signMessage({ message: { raw: params[0] } });
      if (method === "eth_sendTransaction") return await wallet.sendTransaction({ to: params[0].to, data: params[0].data, value: params[0].value ? BigInt(params[0].value) : undefined });
      return await client.request({ method, params });
    } catch (error) {
      return { __error: String(error).slice(0, 300) };
    }
  });
  await ctx.addInitScript(`(() => { const L = {}; window.ethereum = { request: ({ method, params }) => window.__rooqWallet(method, params ?? []).then((r) => { if (r && r.__error) throw Object.assign(new Error(r.__error), { code: -32000 }); return r; }), on: (e, f) => { (L[e] ??= []).push(f); }, removeListener: (e, f) => { L[e] = (L[e] ?? []).filter((x) => x !== f); } }; })();`);
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`   console error: ${m.text().slice(0, 200)}`);
  });
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const name = `frames/${String(frames.length).padStart(6, "0")}.jpg`;
    writeFileSync(`${out}/${name}`, Buffer.from(data, "base64"));
    frames.push({ name, t: metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  if (out) await cdp.send("Page.startScreencast", { format: "jpeg", quality: 96, maxWidth: 3840, maxHeight: 2160, everyNthFrame: 1 });
  const t0 = Date.now();
  const marks = {};

  return {
    page,
    mark(name) {
      marks[name] = (Date.now() - t0) / 1000;
      console.log(`${name} ${marks[name].toFixed(2)}`);
    },
    async navigate(path) {
      await page.evaluate((p) => window.next.router.push(p), path);
      await page.waitForURL(`**${path.split("?")[0]}**`, { timeout: 60000 });
    },
    /** Connects and signs in the inline account sheet, then waits for it to close. */
    async signIn({ pause = 0 } = {}) {
      const sheet = page.getByTestId("account-sheet");
      if (!(await sheet.waitFor({ timeout: 15000 }).then(() => true).catch(() => false))) return;
      const connect = sheet.getByRole("button", { name: "Connect wallet" });
      if (await connect.isVisible().catch(() => false)) {
        await page.waitForTimeout(pause);
        await connect.click();
        await page.waitForTimeout(pause);
        await page.getByTestId("rk-wallet-option-injected").click({ timeout: 20000 });
      }
      await page.waitForTimeout(pause);
      await sheet.getByRole("button", { name: /Sign to continue/ }).click({ timeout: 30000 });
      await sheet.waitFor({ state: "detached", timeout: 120000 });
    },
    /** Opens the private account from the overview, off camera time that the edit cuts. */
    async openAccount() {
      await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await page.getByRole("button", { name: "Open account to show it" }).click({ timeout: 120000 });
      await this.signIn();
      await page.waitForTimeout(2000);
    },
    async confirmedOps() {
      await page.getByRole("button", { name: /Operations/ }).first().click();
      await page.waitForTimeout(800);
      const count = await page.getByRole("dialog").getByRole("listitem").filter({ hasText: "Confirmed" }).count();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      return count;
    },
    /** Opens Operations and waits, on camera, until one more item than `before` is confirmed. */
    async waitOperation(before, timeout = 420000) {
      await page.getByRole("button", { name: /Operations/ }).first().click();
      const items = page.getByRole("dialog").getByRole("listitem");
      const start = Date.now();
      for (;;) {
        if ((await items.filter({ hasText: "Confirmed" }).count()) > before) return;
        const top = (await items.first().textContent({ timeout: 5000 }).catch(() => "")) ?? "";
        if (/Quote expired|Failed|Needs your attention|Cancelled/.test(top)) throw new Error(top.replace(/\s+/g, " ").slice(0, 160));
        if (Date.now() - start > timeout) throw new Error("operation timed out");
        await page.waitForTimeout(1000);
      }
    },
    async fail(error) {
      console.log(`RECORD FAILED: ${String(error).slice(0, 400)}`);
      if (out) await page.screenshot({ path: `${out}/failure.png` }).catch(() => undefined);
      await page.getByRole("button", { name: /Operations/ }).first().click().catch(() => undefined);
      await page.waitForTimeout(800);
      console.log(`operations: ${((await page.getByRole("dialog").innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 500)}`);
    },
    async finish() {
      const stoppedAt = Date.now() / 1000;
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      await ctx.close();
      await browser.close();
      if (!out) return;
      // Each frame holds until the next one, and the last until capture stopped; marks are re-based on the first frame's clock so they match the video.
      const first = frames[0]?.t ?? t0 / 1000;
      const list = frames.map((f, i) => `file '${f.name}'\nduration ${((frames[i + 1]?.t ?? Math.max(stoppedAt, f.t + 0.5)) - f.t).toFixed(4)}`);
      writeFileSync(`${out}/frames.txt`, `${list.join("\n")}\nfile '${frames.at(-1)?.name}'\n`);
      const offset = t0 / 1000 - first;
      writeFileSync(`${out}/marks.json`, JSON.stringify(Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, +(v + offset).toFixed(3)])), null, 2));
      console.log(`frames ${frames.length}`);
    },
  };
}
