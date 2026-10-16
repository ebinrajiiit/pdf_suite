import { defineConfig } from "@playwright/test";

// Runs against the production build, not `pnpm dev`: the service worker only
// exists in a build, and the offline test needs it.
export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "pnpm build && pnpm preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
