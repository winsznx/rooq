/**
 * Drives a real browser through private Rooq against the local stack (`pnpm dev:all`) with injected test wallets on anvil's
 * unlocked accounts. Real signatures, keys and browser proofs. Chromium's virtual authenticator stands in for a passkey.
 *   node apps/web/scripts/private-browser-flow.mjs [screenshot-dir]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/mac/rooq/e2e/node_modules/@playwright/test/index.mjs";

const SHOTS = process.argv[2] ?? "/tmp/rooq-private-shots";
mkdirSync(SHOTS, { recursive: true });
const RPC = process.env.FLOW_RPC ?? "http://127.0.0.1:8548";
const BASE = process.env.FLOW_WEB ?? "http://localhost:3200";
const READ = process.env.FLOW_READ ?? "http://127.0.0.1:8710";
const EOA_A = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"; // anvil 9
const EOA_B = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f"; // anvil 8
const DEPLOYER = execFileSync("cast", ["wallet", "private-key", "--mnemonic", "test test test test test test test test test test test junk", "--mnemonic-index", "0"], { encoding: "utf8" }).trim();
const deployment = await (await fetch(`${READ}/v1/deployment`)).json();
const cast = (args) => execFileSync("cast", [...args, "--rpc-url", RPC], { encoding: "utf8" }).trim();
for (const eoa of [EOA_A, EOA_B]) for (const [t, a] of [[deployment.asset, "3000000000"], [deployment.spotTokens[0], "300000000000000000000"], [deployment.spotTokens[1], "300000000000000000000"]]) cast(["send", t, "mintTo(address,uint256)", eoa, a, "--private-key", DEPLOYER]);

const walletScript = ({ account, randomSign = false }) => `(() => {
  let current = "${account}";
  const listeners = {};
  window.__signCount = 0;
  const rpc = async (method, params) => {
    const r = await fetch("${RPC}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
    return j.result;
  };
  window.__switchAccount = (next) => { current = next; (listeners.accountsChanged ?? []).forEach((f) => f([next])); };
  window.ethereum = {
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [current];
      if (method === "eth_chainId") return "0x7a69";
      if (method === "wallet_getPermissions" || method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "personal_sign") {
        window.__signCount++;
        ${randomSign ? `return "0x" + Array.from(crypto.getRandomValues(new Uint8Array(65)), (b) => b.toString(16).padStart(2, "0")).join("");` : `return rpc("personal_sign", params);`}
      }
      return rpc(method, params);
    },
    on: (e, f) => { (listeners[e] ??= []).push(f); },
    removeListener: (e, f) => { listeners[e] = (listeners[e] ?? []).filter((x) => x !== f); },
  };
})();`;

const browser = await chromium.launch({ headless: true });
const consoleErrors = [];

async function session(label, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (!opts.noWallet) await ctx.addInitScript(walletScript({ account: opts.account ?? EOA_A, randomSign: opts.randomSign }));
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`[${label}] ${m.text().slice(0, 300)}`);
    if (/proved in/.test(m.text())) console.log(`   ${label}: ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`[${label}] PAGEERROR ${e.message.slice(0, 300)}`));
  return { ctx, page };
}

const shot = async (page, name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  console.log(`shot ${name}`);
};
const step = (s) => console.log(`\n== ${s}`);

async function connectIfAsked(page) {
  const sheet = page.getByTestId("account-sheet");
  await sheet.waitFor({ timeout: 30000 });
  const connect = sheet.getByRole("button", { name: "Connect wallet" });
  if (await connect.isVisible().catch(() => false)) {
    await connect.click();
    await page.getByTestId("rk-wallet-option-injected").click({ timeout: 20000 });
  }
}

/** Handles the inline sheet that any account action opens, then lets the action continue. */
async function signIn(page) {
  await connectIfAsked(page);
  const sheet = page.getByTestId("account-sheet");
  const button = sheet.getByRole("button", { name: /Sign to continue/ });
  await button.waitFor({ timeout: 20000 });
  await button.click();
  await sheet.waitFor({ state: "detached", timeout: 60000 });
}

async function waitOp(page, title, timeout = 240000) {
  await page.getByRole("button", { name: /Operations/ }).first().click();
  const dialog = page.getByRole("dialog");
  const t0 = Date.now();
  for (;;) {
    const card = dialog.getByRole("listitem").filter({ hasText: title }).first();
    const text = (await card.textContent({ timeout: 5000 }).catch(() => "")) ?? "";
    if (/Confirmed|Quote expired|Failed|Needs your attention|Cancelled/.test(text)) {
      console.log(`   op "${title}": ${text.replace(/\s+/g, " ").slice(0, 170)} (${Date.now() - t0} ms)`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      if (!/Confirmed/.test(text)) throw new Error(`op failed: ${text}`);
      return;
    }
    if (Date.now() - t0 > timeout) throw new Error(`timeout on ${title}: ${text}`);
    await page.waitForTimeout(800);
  }
}

const goto = async (page, path) => {
  await page.locator(`nav a[href="${path}"]`).first().click();
  await page.waitForURL(`**${path}**`);
};

async function shield(page, symbol, amount) {
  await page.getByRole("button", { name: "Shield" }).first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: new RegExp(symbol) }).click();
  await dlg.getByLabel("Amount").fill(amount);
  await dlg.getByRole("button", { name: "Shield", exact: true }).click();
  await dlg.getByText(/Shielded\. It enters/).waitFor({ timeout: 60000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

const PUBLIC = ["/app", "/app/markets", "/app/trade/TSLA?mode=perps", "/app/swap", "/app/portfolio", "/app/liquidity"];
const shotName = (p) => p.replace(/^\/app\/?/, "").replace(/[/?=]/g, "-") || "overview";

async function publicShots(page, tag, width, height) {
  await page.setViewportSize({ width, height });
  for (const p of PUBLIC) {
    await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(3500);
    await shot(page, `${tag}-${width}-${shotName(p)}`);
  }
}

async function createMarket() {
  step("create a market on PrivateMarkets");
  const m = await session("creator");
  await m.page.goto(`${BASE}/app/create`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await m.page.getByLabel("Open interest limit").waitFor({ timeout: 60000 });
  await m.page.waitForTimeout(1500);
  await shot(m.page, "20-create");
  await m.page.getByLabel("Open interest limit").fill("1000000");
  await m.page.getByLabel("Bond").fill("50");
  const wg = m.page.getByRole("button", { name: /Connect wallet|^Connect$/ }).last();
  if (await wg.isVisible().catch(() => false)) {
    await wg.click();
    await m.page.getByTestId("rk-wallet-option-injected").click({ timeout: 20000 });
  }
  await m.page.getByRole("button", { name: "Create market" }).click({ timeout: 30000 });
  await m.page.getByTestId("market-created").waitFor({ timeout: 120000 });
  console.log("   created:", (await m.page.getByTestId("market-created").innerText()).replace(/\n+/g, " | ").slice(0, 200));
  await shot(m.page, "21-created");
  await goto(m.page, "/app/makers");
  await m.page.waitForTimeout(6000);
  console.log("   on maker desk:", await m.page.getByRole("group", { name: "Market" }).innerText());
  await shot(m.page, "22-maker-desk");
  await m.ctx.close();
}

step("disconnected: every page renders for everyone");
const anon = await session("anon", { noWallet: true });
await publicShots(anon.page, "disconnected", 1440, 1000);
await publicShots(anon.page, "disconnected", 390, 844);
console.log("   status bar:", (await anon.page.locator("footer").first().innerText().catch(() => "")).replace(/\s+/g, " "));
await anon.ctx.close();

step("first private action opens the sheet; connect, sign twice, action continues");
const { ctx, page } = await session("main");
await page.goto(`${BASE}/app/portfolio`, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.getByText("Private balances").first().waitFor({ timeout: 60000 });
await page.getByRole("button", { name: "Shield" }).first().click();
await shot(page, "01-sheet");
await signIn(page);
console.log("   signatures requested:", await page.evaluate(() => window.__signCount));
await page.getByRole("dialog").getByRole("button", { name: /USDG/ }).waitFor({ timeout: 15000 });
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Show values" }).first().click();
const addrA = await page.getByTestId("private-address").getAttribute("title");
console.log("   private address:", addrA.slice(0, 22));

step("shield collateral and spot tokens");
await shield(page, "USDG", "1500");
await shield(page, "TSLA", "100");
await shield(page, "AMZN", "100");
await page.waitForFunction(() => /1,?500\.0000 USDG/.test(document.body.innerText), null, { timeout: 120000 });
await shot(page, "02-shielded");

step("open private long on the trading page");
await goto(page, "/app/trade");
await page.getByLabel("Size").waitFor({ timeout: 30000 });
await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 3000 }).catch(() => undefined);
await page.getByLabel("Size").fill("1");
await page.getByLabel("Margin").fill("100");
await shot(page, "03-trade-ticket");
await page.getByRole("button", { name: "Place order" }).click();
await waitOp(page, "Open long 1", 240000);
await page.getByTestId("position-card").first().waitFor({ timeout: 60000 });
await shot(page, "04-trade-position");

step("add margin, close");
await page.getByRole("button", { name: "Manage" }).first().click();
await page.getByRole("dialog").getByLabel("Add margin").fill("10");
await page.getByRole("dialog").getByRole("button", { name: "Add margin" }).click();
await waitOp(page, "Add margin");
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Manage" }).first().click();
await page.getByRole("dialog").getByRole("tab", { name: "Close" }).click();
await page.getByRole("dialog").getByRole("button", { name: "Close position" }).click();
await waitOp(page, "Close Long");

step("liquidity, swap");
await goto(page, "/app/liquidity");
const adds = page.locator('section[aria-label^="Add to"]');
await adds.first().waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
await adds.nth(0).getByLabel(/USDG/).fill("500");
await adds.nth(0).getByLabel(/TSLA/).fill("50");
await adds.nth(0).getByRole("button", { name: "Add liquidity" }).click();
await waitOp(page, "Add liquidity", 300000);
await page.getByTestId("lp-row").first().waitFor({ timeout: 60000 });
await shot(page, "05-lp");
await goto(page, "/app/swap");
await page.getByRole("group", { name: "From" }).getByRole("button", { name: "USDG" }).click();
await page.getByRole("group", { name: "To" }).getByRole("button", { name: "TSLA" }).click();
await page.getByLabel("Amount").fill("25");
await page.getByText(/You receive, est\.[\s\S]*TSLA/).waitFor({ timeout: 30000 });
await shot(page, "06-swap-quote");
await page.getByRole("button", { name: "Swap", exact: true }).click();
await waitOp(page, "Swap 25", 300000);
await goto(page, "/app/liquidity");
await page.getByTestId("lp-row").first().getByRole("button", { name: "Remove" }).click();
await page.getByRole("dialog").getByRole("button", { name: "Request removal" }).click();
await waitOp(page, "Remove liquidity", 300000);
await page.waitForFunction(() => document.body.innerText.includes("No liquidity yet"), null, { timeout: 180000 });
await goto(page, "/app/activity");
await page.getByTestId("activity-list").waitFor({ timeout: 60000 });
await shot(page, "07-activity");

async function balances(p) {
  await goto(p, "/app/portfolio");
  await p.getByText("Private balances").first().waitFor({ timeout: 60000 });
  await p.getByRole("button", { name: "Show values" }).first().click({ timeout: 4000 }).catch(() => undefined);
  await p.waitForFunction(() => !/Arriving/.test(document.querySelector('section[aria-label="Private balances"]')?.innerText ?? ""), null, { timeout: 90000 });
  await p.waitForTimeout(1500);
  return p.locator('section[aria-label="Private balances"]').innerText();
}
const balA = (await balances(page)).split("Your private address")[0];
console.log("   balances A:", balA.replace(/\n+/g, " | "));
await shot(page, "08-portfolio-connected");
for (const width of [1440, 390]) {
  for (const p of ["/app", "/app/markets", "/app/trade", "/app/swap", "/app/portfolio", "/app/liquidity"]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await goto(page, p);
    await page.waitForTimeout(2000);
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.waitForTimeout(1500);
    await shot(page, `connected-${width}-${shotName(p)}`);
  }
}
await page.setViewportSize({ width: 1440, height: 1000 });

step("restore on a fresh profile by connecting and signing again");
const fresh = await session("fresh");
await fresh.page.goto(`${BASE}/app/portfolio`, { waitUntil: "domcontentloaded", timeout: 120000 });
await fresh.page.getByText("Private balances").first().waitFor({ timeout: 60000 });
await fresh.page.getByRole("button", { name: "Shield" }).first().click();
await signIn(fresh.page);
await fresh.page.keyboard.press("Escape");
const addrFresh = await fresh.page.getByTestId("private-address").getAttribute("title");
const balFresh = (await balances(fresh.page)).split("Your private address")[0];
console.log("   same address:", addrFresh === addrA, " same balances:", balFresh === balA);
console.log("   balances fresh:", balFresh.replace(/\n+/g, " | "));
await shot(fresh.page, "09-restored");
await goto(fresh.page, "/app/activity");
await fresh.page.getByTestId("activity-list").waitFor({ timeout: 60000 });
await fresh.page.getByRole("button", { name: "Show values" }).first().click({ timeout: 3000 }).catch(() => undefined);
await shot(fresh.page, "10-restored-activity");

step("unshield through the relayer from the restored profile");
await goto(fresh.page, "/app/portfolio");
await fresh.page.getByText("Private balances").first().waitFor({ timeout: 60000 });
await fresh.page.getByRole("button", { name: "Unshield" }).first().click();
const un = fresh.page.getByRole("dialog");
await un.getByRole("button", { name: /USDG/ }).click();
await un.getByLabel("Amount").fill("20");
await un.getByRole("button", { name: "Unshield" }).click();
await waitOp(fresh.page, "Unshield 20", 180000);
console.log("   EOA USDG after:", cast(["call", deployment.asset, "balanceOf(address)(uint256)", EOA_A]));
await fresh.ctx.close();

step("remember device with a device key; lock; unlock without signing");
await page.goto(`${BASE}/app/portfolio`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Shield" }).first().waitFor({ timeout: 30000 });
await page.getByRole("button", { name: "Shield" }).first().click();
await signIn(page).catch(async (e) => { await shot(page, "err-resign"); throw e; });
await page.keyboard.press("Escape");
await page.getByRole("button", { name: /this device's key/ }).first().click();
await page.waitForTimeout(800);
await goto(page, "/app/settings");
await page.getByRole("button", { name: "Lock now" }).click({ timeout: 30000 });
await page.waitForTimeout(800);
const signsBefore = await page.evaluate(() => window.__signCount);
await goto(page, "/app/portfolio");
await page.getByRole("button", { name: "Shield" }).first().click();
await page.getByTestId("account-sheet").getByRole("button", { name: "Unlock on this device" }).click({ timeout: 30000 });
await page.getByRole("dialog").getByRole("button", { name: /USDG/ }).waitFor({ timeout: 30000 });
await page.keyboard.press("Escape");
console.log("   unlocked without a signature:", (await page.evaluate(() => window.__signCount)) === signsBefore);

step("wallet switch: other wallet, other account, no mixing");
const addrBefore = await page.getByTestId("private-address").getAttribute("title");
await page.evaluate((b) => window.__switchAccount(b), EOA_B);
await page.waitForTimeout(2500);
console.log("   after switch, address hidden:", !(await page.getByTestId("private-address").isVisible().catch(() => false)));
await page.getByRole("button", { name: "Shield" }).first().click();
await page.getByTestId("account-sheet").getByRole("button", { name: /Sign to continue/ }).click({ timeout: 20000 });
await page.getByRole("dialog").getByRole("button", { name: /USDG/ }).waitFor({ timeout: 30000 });
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Show values" }).first().click({ timeout: 2000 }).catch(() => undefined);
await page.waitForTimeout(3000);
const addrB = await page.getByTestId("private-address").getAttribute("title");
console.log("   different account:", addrB !== addrBefore, " balances B:", (await page.locator('section[aria-label="Private balances"]').innerText()).split("Your private address")[0].replace(/\n+/g, " | "));
await page.evaluate((a) => window.__switchAccount(a), EOA_A);
await page.waitForTimeout(2000);
console.log("   back to A, needs unlock:", !(await page.getByTestId("private-address").isVisible().catch(() => false)));
await ctx.close();

step("non-deterministic wallet: refused, then a passkey account; remember with PRF; PRF-less authenticator");
const pk = await session("passkey", { randomSign: true, account: "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a" });
const cdp = await pk.ctx.newCDPSession(pk.page);
await cdp.send("WebAuthn.enable");
const auth = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
await pk.page.goto(`${BASE}/app/portfolio`, { waitUntil: "domcontentloaded" });
await pk.page.getByText("Private balances").first().waitFor({ timeout: 60000 });
await pk.page.getByRole("button", { name: "Shield" }).first().click();
await connectIfAsked(pk.page);
await pk.page.getByTestId("account-sheet").getByRole("button", { name: /Sign to continue/ }).click({ timeout: 20000 });
await pk.page.getByText(/signed the same message two different ways/).first().waitFor({ timeout: 30000 });
await shot(pk.page, "11-non-deterministic");
await pk.page.getByTestId("account-sheet").getByRole("button", { name: "Create a passkey account" }).click({ timeout: 30000 });
await pk.page.getByTestId("account-sheet").waitFor({ state: "detached", timeout: 60000 });
await pk.page.keyboard.press("Escape");
const addrPk = await pk.page.getByTestId("private-address").getAttribute("title");
console.log("   passkey account:", addrPk.slice(0, 22));
await pk.page.getByRole("button", { name: "Use a passkey" }).first().click();
await pk.page.getByRole("button", { name: "Use a passkey" }).first().waitFor({ state: "detached", timeout: 20000 }).catch(async () => { console.log("   remember note:", await pk.page.locator('section[aria-label="Remember this device"]').innerText()); });
await goto(pk.page, "/app/settings");
await pk.page.getByRole("button", { name: "Lock now" }).click({ timeout: 30000 });
await pk.page.waitForTimeout(600);
await goto(pk.page, "/app/portfolio");
await pk.page.getByRole("button", { name: "Shield" }).first().click();
await pk.page.getByTestId("account-sheet").getByRole("button", { name: "Unlock with passkey" }).click({ timeout: 30000 });
await pk.page.getByRole("dialog").getByRole("button", { name: /USDG/ }).waitFor({ timeout: 30000 });
await pk.page.keyboard.press("Escape");
console.log("   passkey unlock, same account:", (await pk.page.getByTestId("private-address").getAttribute("title")) === addrPk);
await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: auth.authenticatorId });
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await pk.page.getByRole("button", { name: /Forget/ }).first().click({ timeout: 5000 }).catch(() => undefined);
await goto(pk.page, "/app/settings");
await pk.page.getByRole("button", { name: "Forget this device" }).click({ timeout: 30000 });
await pk.page.waitForTimeout(800);
await pk.page.getByRole("button", { name: "Use a passkey" }).first().click({ timeout: 20000 });
await pk.page.getByText(/doesn't support passkey unlock/).waitFor({ timeout: 20000 });
console.log("   PRF unsupported handled: named message, device key still offered:", await pk.page.getByRole("button", { name: /this device's key/ }).first().isVisible());
await pk.ctx.close();

await createMarket();

console.log("\nconsole errors:", consoleErrors.length);
for (const e of consoleErrors.slice(0, 20)) console.log(" ", e);
await browser.close();
console.log("FLOW COMPLETE");
