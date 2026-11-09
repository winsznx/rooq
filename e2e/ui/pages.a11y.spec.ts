import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ROUTES = ["/", "/how-it-works", "/learn", "/docs", "/developers", "/status", "/app", "/app/markets", "/app/trade/TSLA?mode=perps", "/app/trade/TSLA?mode=spot", "/app/swap", "/app/portfolio", "/app/activity", "/app/settings"];

for (const theme of ["light", "dark"] as const) {
  for (const route of ROUTES) {
    test(`${theme} ${route} has no serious accessibility violations`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("rooq-theme", t), theme);
      const response = await page.goto(route);
      // #then the route itself exists; an accessible 404 page must not count as a pass
      expect(response?.status(), `${route} status`).toBeLessThan(400);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1200);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude("nextjs-portal").analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious.map((v) => `${v.id}: ${v.nodes.length} node(s) ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
    });
  }
}

test("keyboard: skip link and dialog focus return", async ({ page }) => {
  await page.goto("/app/markets");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  const trigger = page.getByRole("button", { name: "Connect wallet" }).first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Connect your wallet" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
