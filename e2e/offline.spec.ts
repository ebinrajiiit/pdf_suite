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

  // The service worker must have precached the app shell before we cut the network.
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return Boolean(reg?.active) && Boolean(navigator.serviceWorker.controller);
  });

  await context.setOffline(true);
  await page.reload();
  // TODO (Phase 1): assert the viewer UI renders from the service-worker cache.
  await expect(page.getByRole("heading", { name: "PDF Suite" })).toBeVisible();
});

test("the service worker caches no documents", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return Boolean(reg?.active);
  });

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls: string[] = [];
    for (const name of names) {
      for (const req of await (await caches.open(name)).keys()) urls.push(req.url);
    }
    return urls;
  });

  expect(cached.filter((u) => /\.pdf(\?|$)/i.test(u))).toEqual([]);
});
