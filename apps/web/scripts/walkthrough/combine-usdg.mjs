/**
 * Merges the private USDG notes of the wallet in LIVE_KEY with the app's Combine button, so one order can fund from them.
 *
 *   LIVE_KEY=0x... node apps/web/scripts/walkthrough/combine-usdg.mjs
 */
import { chromium } from "/Users/mac/rooq/e2e/node_modules/@playwright/test/index.mjs";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://rpc.testnet.chain.robinhood.com";
const chain = defineChain({ id: 46630, name: "Robinhood Chain testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = privateKeyToAccount(process.env.LIVE_KEY);
const client = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.exposeFunction("__rooqWallet", async (method, params) => {
  try {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [account.address];
    if (method === "eth_chainId") return "0xb626";
    if (method === "wallet_getPermissions" || method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "personal_sign") return await account.signMessage({ message: { raw: params[0] } });
    if (method === "eth_sendTransaction") return await wallet.sendTransaction({ to: params[0].to, data: params[0].data, value: params[0].value ? BigInt(params[0].value) : undefined });
    return await client.request({ method, params });
  } catch (error) {
    return { __error: String(error).slice(0, 300) };
  }
});
await ctx.addInitScript(`(() => { const L = {}; window.ethereum = { request: ({ method, params }) => window.__rooqWallet(method, params ?? []).then((r) => { if (r && r.__error) throw Object.assign(new Error(r.__error), { code: -32000 }); return r; }), on: (e, f) => { (L[e] ??= []).push(f); }, removeListener: () => {} }; })();`);
const page = await ctx.newPage();
await page.goto("https://rooq.trade/app/portfolio", { waitUntil: "domcontentloaded", timeout: 180000 });
await page.getByRole("button", { name: "Shield" }).first().click({ timeout: 90000 });
const sheet = page.getByTestId("account-sheet");
await sheet.waitFor({ timeout: 30000 });
const connect = sheet.getByRole("button", { name: "Connect wallet" });
if (await connect.isVisible().catch(() => false)) { await connect.click(); await page.getByTestId("rk-wallet-option-injected").click({ timeout: 20000 }); }
await sheet.getByRole("button", { name: /Sign to continue/ }).click({ timeout: 30000 });
await sheet.waitFor({ state: "detached", timeout: 120000 });
await page.keyboard.press("Escape");
await page.waitForTimeout(8000);
const usdg = page.locator("li, div").filter({ hasText: /^USDG/ }).getByRole("button", { name: "Combine" }).first();
let combined = 0;
for (let round = 0; round < 24; round++) {
  const row = page.getByRole("button", { name: "Combine" });
  if ((await row.count()) === 0) break;
  const target = (await usdg.count()) > 0 ? usdg : row.last();
  if (!(await target.isVisible().catch(() => false))) break;
  await target.click();
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.getByRole("button", { name: /Operations/ }).first().click();
  const ok = await page.getByRole("dialog").getByRole("listitem").first().filter({ hasText: /Confirmed|Failed/ }).waitFor({ timeout: 300000 }).then(() => true).catch(() => false);
  const text = ((await page.getByRole("dialog").getByRole("listitem").first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 120);
  console.log(`combine ${round + 1}: ${ok ? text : "timed out"}`);
  if (/nothing to combine/i.test(text)) break;
  await page.keyboard.press("Escape");
  combined++;
  await page.waitForTimeout(6000);
}
console.log(`combine rounds ${combined}`);

await browser.close();
