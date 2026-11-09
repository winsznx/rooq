/**
 * Drives the production site on Robinhood Chain testnet through a real browser: real wallet signatures from a key held by
 * this Node process, real browser proofs and real transactions. Seeds the five USDG pools, then trades.
 *
 *   LIVE_KEY=0x... node apps/web/scripts/live-testnet-flow.mjs [screenshot-dir]
 */
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/mac/rooq/e2e/node_modules/@playwright/test/index.mjs";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const SHOTS = process.argv[2] ?? "/tmp/rooq-live-shots";
mkdirSync(SHOTS, { recursive: true });
const BASE = process.env.FLOW_WEB ?? "https://rooq.trade";
const RPC = "https://rpc.testnet.chain.robinhood.com";
const CHAIN_ID_HEX = "0xb626";
const POOLS = [
  ["TSLA", "0.2514"],
  ["AMZN", "0.3448"],
  ["PLTR", "0.5555"],
  ["NFLX", "0.9", "57.4"],
  ["AMD", "0.1987"],
];
const POOL_USDG = "90";

const chain = defineChain({ id: 46630, name: "Robinhood Chain testnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = privateKeyToAccount(process.env.LIVE_KEY);
const client = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

async function walletRequest(method, params) {
  if (method === "eth_requestAccounts" || method === "eth_accounts") return [account.address];
  if (method === "eth_chainId") return CHAIN_ID_HEX;
  if (method === "wallet_getPermissions" || method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
  if (method === "wallet_switchEthereumChain") return null;
  if (method === "personal_sign") return account.signMessage({ message: { raw: params[0] } });
  if (method === "eth_sendTransaction") {
    const [tx] = params;
    return wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined });
  }
  return client.request({ method, params });
}

const WALLET_SCRIPT = `(() => {
  const listeners = {};
  window.ethereum = {
    isRooqLiveTest: true,
    request: ({ method, params }) => window.__rooqWallet(method, params ?? []).then((r) => {
      if (r && r.__error) throw Object.assign(new Error(r.__error), { code: -32000 });
      return r;
    }),
    on: (e, f) => { (listeners[e] ??= []).push(f); },
    removeListener: (e, f) => { listeners[e] = (listeners[e] ?? []).filter((x) => x !== f); },
  };
})();`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.exposeFunction("__rooqWallet", async (method, params) => {
  try {
    return await walletRequest(method, params);
  } catch (error) {
    console.log(`   wallet error on ${method}: ${String(error).slice(0, 200)}`);
    return { __error: String(error).slice(0, 300) };
  }
});
await ctx.addInitScript(WALLET_SCRIPT);
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  if (/proved in/.test(m.text())) console.log(`   ${m.text()}`);
});
page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR ${e.message.slice(0, 300)}`));

const step = (s) => console.log(`\n== ${s}`);
const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};
const goto = async (path) => {
  await page.locator(`nav a[href="${path}"]`).first().click();
  await page.waitForURL(`**${path}**`);
};

async function signIn() {
  const sheet = page.getByTestId("account-sheet");
  await sheet.waitFor({ timeout: 60000 });
  const connect = sheet.getByRole("button", { name: "Connect wallet" });
  if (await connect.isVisible().catch(() => false)) {
    await connect.click();
    await page.getByTestId("rk-wallet-option-injected").click({ timeout: 20000 });
  }
  const button = sheet.getByRole("button", { name: /Sign to continue/ });
  await button.waitFor({ timeout: 30000 });
  await button.click();
  await sheet.waitFor({ state: "detached", timeout: 90000 });
}

async function confirmedOps() {
  await page.getByRole("button", { name: /Operations/ }).first().click();
  const items = page.getByRole("dialog").getByRole("listitem");
  await page.waitForTimeout(800);
  const count = await items.filter({ hasText: "Confirmed" }).count();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  return count;
}

/** Waits until one more operation than `before` has confirmed. Fails if the newest operation fails. */
async function waitOp(title, before, timeout = 420000) {
  await page.getByRole("button", { name: /Operations/ }).first().click();
  const dialog = page.getByRole("dialog");
  const items = dialog.getByRole("listitem");
  const start = Date.now();
  for (;;) {
    const confirmed = await items.filter({ hasText: "Confirmed" }).count();
    const top = (await items.first().textContent({ timeout: 5000 }).catch(() => "")) ?? "";
    if (confirmed > before || /Quote expired|Failed|Needs your attention|Cancelled/.test(top)) {
      console.log(`   op "${title}": ${top.replace(/\s+/g, " ").slice(0, 170)} (${Date.now() - start} ms)`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      if (confirmed <= before) throw new Error(`op failed: ${top}`);
      return;
    }
    if (Date.now() - start > timeout) throw new Error(`timeout on ${title}: ${top}`);
    await page.waitForTimeout(1500);
  }
}

async function shield(symbol, amount) {
  await page.getByRole("button", { name: "Shield" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: new RegExp(symbol) }).click();
  await dialog.getByLabel("Amount").fill(amount);
  await dialog.getByRole("button", { name: "Shield", exact: true }).click();
  await dialog.getByText(/Shielded\. It enters/).waitFor({ timeout: 120000 });
  console.log(`   shielded ${amount} ${symbol}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
}

try {
  step("open account");
  await page.goto(`${BASE}/app/portfolio`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.getByRole("button", { name: "Shield" }).first().click({ timeout: 60000 });
  await signIn();
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await shot("01-account");

  if (!process.env.LIVE_SKIP_SHIELD) {
    step("shield");
    await shield("USDG", "560");
    for (const [symbol] of POOLS) await shield(symbol, "1");
    console.log("   waiting for the queue to add deposits");
    await page.waitForTimeout(150000);
    await shot("02-shielded");
  }

  step("seed pools");
  await goto("/app/liquidity");
  const forms = page.locator('section[aria-label^="Add to"]');
  await forms.first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(8000);
  for (const [symbol, amount, usdg = POOL_USDG] of POOLS) {
    const form = page.locator(`section[aria-label^="Add to"]`).filter({ hasText: `USDG / ${symbol}` }).first();
    if (await form.getByText("0.3% fee").isVisible().catch(() => false)) {
      console.log(`   ${symbol} pool already seeded`);
      continue;
    }
    await form.getByLabel(/USDG/).fill(usdg);
    await form.getByLabel(new RegExp(symbol)).fill(amount);
    await form.getByRole("button", { name: "Add liquidity" }).click();
    await form.getByText("0.3% fee").waitFor({ timeout: 420000 });
    console.log(`   seeded ${symbol}`);
    await page.waitForTimeout(15000);
  }
  await shot("03-pools");

  let before = 0;
  if (!process.env.LIVE_SKIP_SWAP) {
    step("swap");
    await goto("/app/swap");
    await page.getByRole("group", { name: "From" }).getByRole("button", { name: "USDG" }).click();
    await page.getByRole("group", { name: "To" }).getByRole("button", { name: "TSLA" }).click();
    await page.getByLabel("Amount").fill("5");
    await page.getByText(/You receive, est\.[\s\S]*TSLA/).waitFor({ timeout: 60000 });
    await shot("04-swap");
    before = await confirmedOps();
    await page.getByRole("button", { name: "Swap", exact: true }).click();
    await waitOp("Swap", before);
  }

  step("open and close a perp");
  await page.goto(`${BASE}/app/trade/TSLA?mode=perps`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByLabel("Size").waitFor({ timeout: 60000 });
  await page.waitForTimeout(6000);
  await page.getByLabel("Size").fill("0.1");
  await page.getByLabel("Margin").fill("30");
  await page.waitForTimeout(5000);
  await shot("05-ticket");
  await page.getByRole("button", { name: "Place order" }).click();
  await signIn();
  await page.getByTestId("position-card").first().waitFor({ timeout: 420000 });
  console.log("   position open");
  await shot("06-position");
  before = await confirmedOps();
  await page.getByRole("button", { name: "Manage" }).first().click();
  await page.getByRole("dialog").getByRole("tab", { name: "Close" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close position" }).click();
  await waitOp("Close long", before);
  await shot("07-closed");

  step("unshield through the relayer");
  await goto("/app/portfolio");
  await page.getByRole("button", { name: "Unshield" }).first().click({ timeout: 30000 });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /USDG/ }).first().click().catch(() => undefined);
  await dialog.getByLabel("Amount").fill("5");
  await dialog.getByLabel("Recipient address").fill(account.address);
  await dialog.getByRole("button", { name: /Unshield/ }).last().click();
  await page.waitForTimeout(1000);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await waitOp("Unshield", before + 1);
  await shot("08-unshielded");

  console.log(`\nconsole errors: ${consoleErrors.length}`);
  for (const e of consoleErrors.slice(0, 10)) console.log(`   ${e}`);
  console.log("LIVE FLOW COMPLETE");
} catch (error) {
  await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => undefined);
  console.log(`LIVE FLOW FAILED: ${String(error).slice(0, 500)}`);
  for (const e of consoleErrors.slice(0, 10)) console.log(`   ${e}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
