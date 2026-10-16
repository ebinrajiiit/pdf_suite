// Privacy guard: the app must never contact a non-self origin, and must keep
// working with the network cut. The viewer flow runs inside the guard so the
// assertion covers real work, not just the shell loading.
import { test, expect, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { readFile } from "node:fs/promises";

type Size = [number, number];

/** Pages are identified by their size — the one property pdf-lib can read back. */
async function fixture(sizes: Size[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const [width, height] of sizes) doc.addPage([width, height]);
  return Buffer.from(await doc.save());
}

async function sizesOf(bytes: Buffer | Uint8Array): Promise<Size[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
}

const PORTRAIT: Size = [595, 842];
const LANDSCAPE: Size = [842, 595];
const SQUARE: Size = [300, 300];

/**
 * The native File System Access pickers cannot be driven by a test, so remove
 * them and let the app take its <input type=file> and download fallbacks — the
 * same paths Firefox and Safari users get.
 */
async function withoutFilePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ["showOpenFilePicker", "showSaveFilePicker"] as const) {
      Reflect.deleteProperty(Window.prototype, name);
      Reflect.deleteProperty(window, name);
    }
  });
}

async function openFixture(page: Page, name: string, bytes: Buffer): Promise<void> {
  await page.setInputFiles('[data-testid="open-input"]', {
    name,
    mimeType: "application/pdf",
    buffer: bytes,
  });
}

test("opens, merges, reorders and saves without contacting any non-self origin", async ({
  page,
  baseURL,
}) => {
  const self = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (new URL(url).origin !== self) foreign.push(url);
  });

  await withoutFilePickers(page);
  await page.goto("/");
  // The engine is a 4.4 MB wasm; nothing can be opened until it has compiled.
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "first.pdf", await fixture([PORTRAIT, LANDSCAPE]));
  await expect(page.getByText("2 pages")).toBeVisible();
  // A canvas with pixels in it proves the worker really rasterised through
  // PdfEngine; being visible would only prove the element mounted.
  const firstPage = page.getByTestId("viewer").getByRole("img", { name: "Page 1" });
  await expect(firstPage).toBeVisible();
  await expect
    .poll(() => firstPage.evaluate((el) => (el as HTMLCanvasElement).width))
    .toBeGreaterThan(0);

  await page.setInputFiles('[data-testid="merge-input"]', {
    name: "second.pdf",
    mimeType: "application/pdf",
    buffer: await fixture([SQUARE]),
  });
  await expect(page.getByText("3 pages")).toBeVisible();

  // Reorder by the keyboard-reachable control rather than dragging.
  await page.getByRole("button", { name: "Move page 1 down" }).click();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save" }).click(),
  ]);
  const saved = await download.path();
  expect(saved).toBeTruthy();

  // Merge appended, then page 1 moved below page 2.
  expect(await sizesOf(await readFile(saved!))).toEqual([LANDSCAPE, PORTRAIT, SQUARE]);

  expect(foreign, `Foreign requests:\n${foreign.join("\n")}`).toEqual([]);
});

test("works with the network cut after first load", async ({ page, context }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // The service worker must have precached the app shell and the engine wasm
  // before we cut the network.
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return Boolean(reg?.active) && Boolean(navigator.serviceWorker.controller);
  });
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await context.setOffline(true);
  await page.reload();

  await expect(page.getByRole("heading", { name: /never leave this device/i })).toBeVisible();
  // Offline is the real test of the privacy claim: the engine still starts.
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
});

test("the service worker caches no documents", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "secret.pdf", await fixture([PORTRAIT]));
  await expect(page.getByText("1 page")).toBeVisible();

  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) urls.push(req.url);
    }
    return urls;
  });

  expect(cached.filter((u) => /\.pdf(\?|$)/i.test(u) || /secret/i.test(u))).toEqual([]);
});
