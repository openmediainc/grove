import { defineConfig, devices } from "@playwright/test";

/**
 * Glasshouse E2E smoke (#69). Signed-out journeys only: it never signs in and
 * never creates anything, so it is safe to point at production.
 *
 *   pnpm test:e2e                                        # the Mini's web on this machine (localhost:3510/grove)
 *   BASE_URL=https://q-ai.tail735569.ts.net/grove pnpm test:e2e   # the Mini over the tailnet
 *   BASE_URL=https://glasshouse.rendrr.app pnpm test:e2e # production
 *   E2E_TARGET=prod pnpm test:e2e                        # same as the line above
 *   E2E_WORKERS=4 / E2E_FAST=1                           # override the dev-server pacing
 *
 * BASE_URL may carry a base path (`/grove`); tests build every address with
 * `url()` from tests/support.ts, never a bare leading slash.
 */
const PROD = "https://glasshouse.rendrr.app";
const LOCAL = "http://localhost:3510/grove";
const base = (process.env.BASE_URL || (process.env.E2E_TARGET === "prod" ? PROD : LOCAL)).replace(/\/+$/, "");
process.env.BASE_URL = base;
// The Mini serves `next dev`, which compiles a route on its first request: give it
// fewer workers and longer waits. A deployed build answers in a second or two.
const devServer = /\/\/(localhost|127\.0\.0\.1|[^/]*\.ts\.net)[:/]/.test(`${base}/`) && !process.env.E2E_FAST;
const workers = Number(process.env.E2E_WORKERS) || (devServer ? 2 : process.env.CI ? 4 : 6);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // A live deploy answers over the internet; one retry absorbs a cold function, not a real failure.
  retries: process.env.CI ? 1 : 0,
  workers,
  timeout: devServer ? 120_000 : 45_000,
  expect: { timeout: devServer ? 30_000 : 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }], ["github"]] : [["list"]],
  use: {
    baseURL: `${base}/`,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: devServer ? 90_000 : 30_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    {
      name: "mobile",
      // Chromium with a 390px phone viewport and touch (not WebKit: Chromium only).
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
    },
  ],
});
