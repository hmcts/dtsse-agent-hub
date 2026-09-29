import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.TEST_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests",
  // Waits for the deployment to be routable before the first spec: see `./wait-for-service.ts`.
  globalSetup: "./wait-for-service.ts",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { outputFolder: "../../playwright-report" }], ["list"]] : "list",
  // The pipeline selects a subset by tag: @smoke on a preview, @regression on AAT, @nightly for the accessibility
  // pass. Left unset, everything runs.
  ...(process.env.E2E_TEST_SCOPE ? { grep: new RegExp(process.env.E2E_TEST_SCOPE) } : {}),
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer"]
    }
  },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"] } }]
});
