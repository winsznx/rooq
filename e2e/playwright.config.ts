import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.WEB_URL ?? "http://localhost:3200";

export default defineConfig({
  testDir: "./ui",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "../docs/evidence/playwright-report.json" }]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testMatch: /.*\.(flow|a11y)\.spec\.ts/ },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" }, testMatch: /.*\.mobile\.spec\.ts/ },
    { name: "screens", use: { ...devices["Desktop Chrome"] }, testMatch: /.*\.screens\.spec\.ts/ },
  ],
});
