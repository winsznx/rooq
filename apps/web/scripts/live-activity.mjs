/**
 * Real testnet activity on the production site: random small swaps in every pool and small long and short perps that
 * open and close, each with a real wallet signature, a real browser proof and a real transaction. Stops before the
 * operator gas wallets run low.
 *
 *   LIVE_KEY=0x... ACTIONS=120 node apps/web/scripts/live-activity.mjs
 */
import { chromium } from "/Users/mac/rooq/e2e/node_modules/@playwright/test/index.mjs";
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.env.FLOW_WEB ?? "https://rooq.trade";
const RPC = "https://rpc.testnet.chain.robinhood.com";
const ACTIONS = Number(process.env.ACTIONS ?? 120);
const MIN_OPERATOR_GAS_WEI = 1_000_000_000_000_000n;
const OPERATOR_WALLETS = {
  coordinator: "0x0ec52416CD54BE1DCeD168A1029004Fc631e0Ff5",
  relayer: "0xe5dAd32cDc950367cf5db2d0Aae01F3079d8a017",
};
const TOKENS = { TSLA: 360, AMZN: 260, PLTR: 160, NFLX: 64, AMD: 450 };
const SYMBOLS = Object.keys(TOKENS);

const chain = defineChain({ id: 46630, name: "Robinhood Chain testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = privateKeyToAccount(process.env.LIVE_KEY);
const client = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (lo, hi, digits) => (lo + Math.random() * (hi - lo)).toFixed(digits);

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

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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

async function navigate(path) {
  await page.evaluate((p) => window.next.router.push(p), path);
  await page.waitForURL(`**${path.split("?")[0]}**`, { timeout: 60000 });
  await page.waitForTimeout(2500);
}

async function signInIfAsked() {
  const sheet = page.getByTestId("account-sheet");
  if (!(await sheet.waitFor({ timeout: 8000 }).then(() => true).catch(() => false))) return;
  const connect = sheet.getByRole("button", { name: "Connect wallet" });
  if (await connect.isVisible().catch(() => false)) {
    await connect.click();
    await page.getByTestId("rk-wallet-option-injected").click({ timeout: 20000 });
  }
  await sheet.getByRole("button", { name: /Sign to continue/ }).click({ timeout: 30000 });
  await sheet.waitFor({ state: "detached", timeout: 90000 });
}

async function confirmedOps() {
  await page.getByRole("button", { name: /Operations/ }).first().click();
  await page.waitForTimeout(800);
  const count = await page.getByRole("dialog").getByRole("listitem").filter({ hasText: "Confirmed" }).count();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  return count;
}

async function waitOp(before, timeout = 420000) {
  await page.getByRole("button", { name: /Operations/ }).first().click();
  const items = page.getByRole("dialog").getByRole("listitem");
  const start = Date.now();
  try {
    for (;;) {
      if ((await items.filter({ hasText: "Confirmed" }).count()) > before) return Date.now() - start;
      const top = (await items.first().textContent({ timeout: 5000 }).catch(() => "")) ?? "";
      if (/Quote expired|Failed|Needs your attention|Cancelled/.test(top)) throw new Error(top.replace(/\s+/g, " ").slice(0, 160));
      if (Date.now() - start > timeout) throw new Error("timed out");
      await page.waitForTimeout(1500);
    }
  } finally {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
}

async function swap() {
  const symbol = pick(SYMBOLS);
  const buy = Math.random() < 0.6;
  const amount = buy ? between(1, 4, 2) : (Number(between(1, 3, 2)) / TOKENS[symbol]).toFixed(4);
  await navigate("/app/swap");
  await page.getByRole("group", { name: "From" }).getByRole("button", { name: buy ? "USDG" : symbol }).click({ timeout: 60000 });
  await page.getByRole("group", { name: "To" }).getByRole("button", { name: buy ? symbol : "USDG" }).click();
  await page.getByLabel("Amount").fill(amount);
  await page.getByText(/You receive, est\./).waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);
  const before = await confirmedOps();
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await signInIfAsked();
  const ms = await waitOp(before);
  return `swap ${amount} ${buy ? "USDG -> " + symbol : symbol + " -> USDG"} (${ms} ms)`;
}

async function perp() {
  const symbol = pick(SYMBOLS);
  const short = Math.random() < 0.5;
  const notional = Number(between(8, 14, 2));
  const size = (notional / TOKENS[symbol]).toFixed(4);
  const margin = (notional * 0.7).toFixed(2);
  await navigate(`/app/trade/${symbol}?mode=perps`);
  await page.getByLabel("Size").waitFor({ timeout: 60000 });
  if (short) await page.getByRole("radio", { name: "Short" }).or(page.getByRole("button", { name: "Short", exact: true })).first().click();
  await page.waitForTimeout(5000);
  await page.getByLabel("Size").fill(size);
  await page.getByLabel("Margin").fill(margin);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Place order|Confirm new price/ }).click();
  await signInIfAsked();
  const confirm = page.getByRole("button", { name: "Confirm new price" });
  if (await confirm.isVisible({ timeout: 4000 }).catch(() => false)) await confirm.click();
  const card = page.getByTestId("position-card").first();
  await card.waitFor({ timeout: 420000 });
  await page.waitForTimeout(Number(between(20, 60, 0)) * 1000);
  const before = await confirmedOps();
  await card.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("dialog").getByRole("tab", { name: "Close" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close position" }).click();
  const ms = await waitOp(before);
  return `${short ? "short" : "long"} ${size} ${symbol}, opened and closed (${ms} ms to close)`;
}

async function operatorGasLow() {
  for (const [name, address] of Object.entries(OPERATOR_WALLETS)) {
    const balance = await client.getBalance({ address });
    if (balance < MIN_OPERATOR_GAS_WEI) return `${name} gas at ${formatEther(balance)} ETH`;
  }
  return null;
}

await page.goto(`${BASE}/app/portfolio`, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.getByRole("button", { name: "Shield" }).first().click({ timeout: 60000 });
await signInIfAsked();
await page.keyboard.press("Escape");
await page.waitForTimeout(2000);

let done = 0;
let failed = 0;
for (let i = 0; i < ACTIONS; i++) {
  const low = await operatorGasLow();
  if (low) {
    console.log(`stopping: ${low}`);
    break;
  }
  const action = Math.random() < 0.65 ? swap : perp;
  try {
    console.log(`${new Date().toISOString().slice(11, 19)} ${i + 1}. ${await action()}`);
    done++;
  } catch (error) {
    failed++;
    console.log(`${new Date().toISOString().slice(11, 19)} ${i + 1}. FAILED ${action.name}: ${String(error).slice(0, 220)}`);
    await page.screenshot({ path: `/tmp/rooq-activity-fail-${i + 1}.png` }).catch(() => undefined);
  }
}
console.log(`ACTIVITY DONE: ${done} confirmed, ${failed} failed`);
await browser.close();
