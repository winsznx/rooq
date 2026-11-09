// Usage: node tools/shot.mjs <path> <outDir> [widths=390,1440] [themes=light,dark]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const [path = "/", out = "./shots", widthsArg = "390,1440", themesArg = "light,dark"] = process.argv.slice(2);
const base = process.env.WEB_URL ?? "http://localhost:3200";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const theme of themesArg.split(",")) {
  for (const w of widthsArg.split(",").map(Number)) {
    const mobile = w < 768;
    const ctx = await browser.newContext({
      viewport: { width: w, height: mobile ? 844 : w >= 1920 ? 1080 : 900 },
      deviceScaleFactor: 1,
      isMobile: mobile,
      hasTouch: mobile,
      colorScheme: theme === "dark" ? "dark" : "light",
    });
    await ctx.addInitScript((t) => localStorage.setItem("rooq-theme", t), theme);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(Number(process.env.SHOT_WAIT ?? 1500));
    const name = `${path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home"}_${w}_${theme}.png`;
    await page.screenshot({ path: `${out}/${name}`, fullPage: process.env.FULL === "1" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`${name} overflowX=${overflow}${errors.length ? ` errors=${JSON.stringify(errors.slice(0, 3))}` : ""}`);
    await ctx.close();
  }
}
await browser.close();
