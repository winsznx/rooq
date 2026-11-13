/**
 * Closes every open position on the live site for the wallet in LIVE_KEY, so the maker's margin returns to it.
 *
 *   LIVE_KEY=0x... node apps/web/scripts/walkthrough/close-all.mjs
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
let closed = 0;
for (let round = 0; round < 8; round++) {
  const manage = page.getByRole("button", { name: "Manage" });
  const n = await manage.count();
  console.log(`open positions: ${n}`);
  if (n === 0) break;
  await manage.first().click();
  await page.getByRole("dialog").getByRole("tab", { name: "Close" }).click({ timeout: 15000 });
  await page.getByRole("dialog").getByRole("button", { name: "Close position" }).click({ timeout: 15000 });
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForFunction((before) => document.querySelectorAll("button").length >= 0 && [...document.querySelectorAll("button")].filter((b) => b.textContent === "Manage").length < before, n, { timeout: 300000 }).then(() => { closed++; }).catch(() => console.log("close did not land in 5 minutes"));
  await page.waitForTimeout(3000);
}
console.log(`closed ${closed}`);
await browser.close();
