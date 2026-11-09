import { expect, test } from "@playwright/test";
import { encodeFunctionData, parseAbi } from "viem";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil account 0, owner of the local mock token
const TRADER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // anvil account 2, the app's local test wallet

/** Setup only: top up the local test wallet with mock collateral so reruns don't drain it. */
test.beforeAll(async () => {
  const dep = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../packages/config/src/deployments/local.json"), "utf8")) as { collateral: string; collateralMode: string };
  if (dep.collateralMode !== "mock") throw new Error("this flow runs against the local mock deployment");
  const data = encodeFunctionData({ abi: parseAbi(["function mintTo(address,uint256)"]), functionName: "mintTo", args: [TRADER, 10_000n * 10n ** 6n] });
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendTransaction", params: [{ from: OWNER, to: dep.collateral, data }] }),
  });
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (!body.result) throw new Error(`top-up failed: ${body.error?.message}`);
});

/**
 * E2E-04, E2E-07, E2E-09: connect, approve then deposit, consent, 2x long through a maker quote, close.
 * Runs against local anvil with the local-only test wallet connector, so every step is a real
 * transaction mined by the chain the app reads.
 */
test("open and close a 2x long through the UI", async ({ page }) => {
  const shots = "../docs/screenshots/flow";
  await page.goto("/app/trade/TSLA?mode=perps");
  await expect(page.getByRole("heading", { name: /mTSLA|TSLA/ })).toBeVisible();

  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await page.getByRole("button", { name: /Local test wallet/ }).click();
  await expect(page.getByRole("button", { name: /Connected 0x/ })).toBeVisible();
  await page.screenshot({ path: `${shots}/01-connected.png` });

  await page.getByRole("button", { name: "Deposit", exact: true }).first().click();
  const deposit = page.getByRole("dialog", { name: "Deposit" });
  await deposit.getByLabel("Amount").fill("3000");
  await deposit.getByRole("button", { name: /Approve, then deposit|^Deposit$/ }).click();
  await expect(deposit.getByText(/Confirmed on (Robinhood Chain|the local chain)/)).toHaveCount(2, { timeout: 60_000 });
  await page.screenshot({ path: `${shots}/02-deposited.png` });
  await deposit.getByRole("button", { name: "Done" }).click();

  await page.getByLabel("Position size").fill("2000");
  await page.getByRole("button", { name: "2.0x" }).click();
  await page.getByRole("button", { name: "Get quote" }).click();

  const consent = page.getByRole("dialog", { name: "Before you trade with leverage" });
  await expect(consent.getByRole("button", { name: "Continue to perps" })).toBeDisabled();
  for (const box of await consent.getByRole("checkbox").all()) await box.check();
  await consent.getByRole("button", { name: "Continue to perps" }).click();

  await expect(page.getByLabel("Maker quote")).toBeVisible();
  await page.screenshot({ path: `${shots}/03-quoted.png` });
  await page.getByRole("button", { name: /Review long/ }).click();

  const review = page.getByRole("dialog", { name: "Review long" });
  await expect(review.getByText("Execution price")).toBeVisible();
  await page.screenshot({ path: `${shots}/04-review.png` });
  await review.getByRole("button", { name: "Confirm in wallet" }).click();
  await expect(review.getByText(/Confirmed on (Robinhood Chain|the local chain)/)).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${shots}/05-confirmed.png` });
  await review.getByRole("button", { name: "Done" }).click();

  const positions = page.getByRole("region", { name: "Positions" });
  await expect(positions.getByText("Long")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${shots}/06-position.png` });

  await positions.getByRole("button", { name: "Close position" }).click();
  const close = page.getByRole("dialog", { name: "Close position" });
  await expect(close.getByText("Estimated realised PnL")).toBeVisible();
  await close.getByRole("button", { name: "Confirm in wallet" }).click();
  await expect(close.getByText(/Confirmed on (Robinhood Chain|the local chain)/)).toBeVisible({ timeout: 60_000 });
  await close.getByRole("button", { name: "Done" }).click();
  await expect(positions.getByText("No positions yet.")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${shots}/07-closed.png` });
});
