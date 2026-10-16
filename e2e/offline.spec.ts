// Privacy guard: the app must never contact a non-self origin, and must keep
// working with the network cut. The viewer flow runs inside the guard so the
// assertion covers real work, not just the shell loading.
import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
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

/** A document with real text, for search. One line per entry, per page. */
async function textFixture(pages: string[][]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    lines.forEach((line, i) => {
      page.drawText(line, { x: 48, y: 760 - i * 20, size: 12, font });
    });
  }
  return Buffer.from(await doc.save());
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

async function rotationsOf(bytes: Buffer | Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getRotation().angle);
}

/** Clicks a button and returns the bytes of the file it downloads. */
async function saveAndRead(page: Page, button: string): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: button }).click(),
  ]);
  const path = await download.path();
  expect(path, `${button} produced no file`).toBeTruthy();
  return readFile(path!);
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

  // Merge appended, then page 1 moved below page 2.
  expect(await sizesOf(await saveAndRead(page, "Save"))).toEqual([LANDSCAPE, PORTRAIT, SQUARE]);

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

test("rotate, delete and extract act on the selected pages", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "three.pdf", await fixture([PORTRAIT, LANDSCAPE, SQUARE]));
  await expect(page.getByText("3 pages")).toBeVisible();

  // Rotating the selection rewrites the document, so it reopens and the
  // selection is cleared — hence selecting again before each step.
  await page.getByTestId("select-0").click();
  await expect(page.getByText("3 pages, 1 selected")).toBeVisible();
  await page.getByRole("button", { name: "Rotate right" }).click();
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  expect(await rotationsOf(await saveAndRead(page, "Save"))).toEqual([90, 0, 0]);

  // Deleting only rewrites the display order, so the page count drops at once.
  await page.getByTestId("select-1").click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("2 pages")).toBeVisible();

  // Extract writes only the selected page and leaves the open document alone.
  await page.getByTestId("select-1").click();
  expect(await sizesOf(await saveAndRead(page, "Extract…"))).toEqual([SQUARE]);
  await expect(page.getByText("2 pages")).toBeVisible();
});

test("a deleted page stays deleted when the document is next rewritten", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "two.pdf", await fixture([PORTRAIT, LANDSCAPE]));
  await page.getByTestId("select-0").click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("1 page")).toBeVisible();

  // Merge rewrites bytes. If it rewrote from the originally opened document
  // instead of what is on screen, the deleted portrait page would come back.
  await page.setInputFiles('[data-testid="merge-input"]', {
    name: "extra.pdf",
    mimeType: "application/pdf",
    buffer: await fixture([SQUARE]),
  });
  await expect(page.getByText("2 pages")).toBeVisible();
  expect(await sizesOf(await saveAndRead(page, "Save"))).toEqual([LANDSCAPE, SQUARE]);
});

test("merging with one page selected inserts after it", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "two.pdf", await fixture([PORTRAIT, LANDSCAPE]));
  await page.getByTestId("select-0").click();
  await expect(page.getByRole("button", { name: "Insert after…" })).toBeEnabled();

  await page.setInputFiles('[data-testid="merge-input"]', {
    name: "inserted.pdf",
    mimeType: "application/pdf",
    buffer: await fixture([SQUARE]),
  });
  await expect(page.getByText("3 pages")).toBeVisible();

  // Inserted between the two originals, not appended after them.
  expect(await sizesOf(await saveAndRead(page, "Save"))).toEqual([PORTRAIT, SQUARE, LANDSCAPE]);
});

test("repairs a damaged file on open instead of refusing it", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  // A mangled header: every object is intact but no engine will touch it until
  // qpdf rebuilds the file (CLAUDE.md §4 — malformed PDFs are normal).
  const damaged = Buffer.from(await fixture([PORTRAIT, LANDSCAPE, SQUARE]));
  damaged.write("%XXX-9.9", 0, "latin1");

  await openFixture(page, "damaged.pdf", damaged);
  await expect(page.getByText("3 pages")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("repaired-badge")).toBeVisible();
  expect(await sizesOf(await saveAndRead(page, "Save"))).toEqual([PORTRAIT, LANDSCAPE, SQUARE]);
});

test("protects a document with a password and opens it again", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "plain.pdf", await fixture([PORTRAIT, SQUARE]));
  await expect(page.getByText("2 pages")).toBeVisible();

  await page.getByRole("button", { name: "Protect…" }).click();
  await page.getByTestId("new-password").fill("institutional-secret");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByTestId("protected-badge")).toBeVisible();

  const encrypted = await saveAndRead(page, "Save");
  // Protection has to survive the save, or opening a protected document and
  // saving it would quietly strip its password.
  await expect(PDFDocument.load(encrypted)).rejects.toThrow();

  // Reopening it asks for the password rather than failing.
  await openFixture(page, "protected.pdf", encrypted);
  await expect(page.getByTestId("password-prompt")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("password").fill("wrong-one");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("status")).toHaveText(/did not work/, { timeout: 30_000 });

  await page.getByTestId("password").fill("institutional-secret");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("2 pages")).toBeVisible({ timeout: 30_000 });
  // Still protected, so saving again keeps the password.
  await expect(page.getByTestId("protected-badge")).toBeVisible();
});

test("compresses a document without losing pages", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "big.pdf", await fixture([PORTRAIT, LANDSCAPE, SQUARE]));
  await page.getByRole("button", { name: "Compress" }).click();
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  expect(await sizesOf(await saveAndRead(page, "Save"))).toEqual([PORTRAIT, LANDSCAPE, SQUARE]);
});

test("finds text, counts the matches and highlights them", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(
    page,
    "results.pdf",
    await textFixture([
      ["Result sheet for semester one", "Candidate: A. Student"],
      ["Result sheet for semester two", "Remarks: none"],
      ["Appendix", "No result here"],
    ]),
  );
  await expect(page.getByText("3 pages")).toBeVisible();

  await page.getByTestId("search-input").fill("result sheet");
  await page.getByRole("button", { name: "Find" }).click();

  // One per page for the first two pages; page 3 says "result" but not the phrase.
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 2", { timeout: 30_000 });
  await expect(page.getByTestId("highlight-0-0")).toBeVisible();

  // Stepping moves to the hit on the second page and marks it active.
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("2 of 2");
  await expect(page.getByTestId("highlight-1-0")).toHaveClass(/highlight-active/);

  // Wrapping round returns to the first hit.
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 2");

  // Searching is case-insensitive and finds the single-word matches too.
  await page.getByTestId("search-input").fill("RESULT");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 3", { timeout: 30_000 });

  await page.getByTestId("search-input").fill("nothing-here");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toBeHidden();
});
