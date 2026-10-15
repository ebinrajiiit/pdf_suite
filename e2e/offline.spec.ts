// Privacy guard: the app must never contact a non-self origin.
// Extend this test as features land (open, render, merge, OCR, save).
import { test, expect } from "@playwright/test";

test("makes no requests to any non-self origin", async ({ page, baseURL }) => {
  const self = new URL(baseURL!).origin;
  const foreign: string[] = [];

  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (new URL(url).origin !== self) foreign.push(url);
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // TODO (Phase 1): load a fixture PDF via the file input, render, merge, save.

  expect(foreign, `Foreign requests:\n${foreign.join("\n")}`).toEqual([]);
});

test("works with the network cut after first load", async ({ page, context }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await context.setOffline(true);
  await page.reload();
  // TODO (Phase 1): assert the viewer UI renders from the service-worker cache.
  await expect(page.locator("body")).toBeVisible();
});
