import { defineConfig } from "@playwright/test";

// Runs against the production build, not `pnpm dev`: the service worker only
// exists in a build, and the offline test needs it.
export default defineConfig({
  testDir: "e2e",
  // Playwright's default is 30 seconds a test, which this suite does not need:
  // a clean run is forty seconds for all of it. It needs the headroom when the
  // machine is busy with something else — a loaded laptop turns a 300ms click
  // into a timeout, and a test that fails for want of CPU says nothing about
  // the code. A real hang still ends, just later.
  timeout: 120_000,
  // On CI, write the HTML report the workflow uploads on failure, and keep the
  // trace of a failed test. Without this the upload step found nothing and
  // every CI-only failure had to be diagnosed from a stack trace alone.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    ...(process.env.CI ? { trace: "retain-on-failure" as const } : {}),
  },
  webServer: {
    command: "pnpm build && pnpm preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
