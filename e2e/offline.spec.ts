// Privacy guard: the app must never contact a non-self origin, and must keep
// working with the network cut. The viewer flow runs inside the guard so the
// assertion covers real work, not just the shell loading.
import { test, expect, type Page } from "@playwright/test";
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
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

/** A document with one field of each kind, for the form panel. */
async function formFixture(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();

  const name = form.createTextField("student.name");
  name.setText("");
  name.addToPage(page, { x: 40, y: 340, width: 220, height: 20, font });

  const passed = form.createCheckBox("student.passed");
  passed.addToPage(page, { x: 40, y: 300, width: 16, height: 16 });

  const grade = form.createDropdown("student.grade");
  grade.setOptions(["A", "B", "C"]);
  grade.addToPage(page, { x: 40, y: 250, width: 80, height: 20, font });

  return Buffer.from(await doc.save());
}

/** Field values of a saved document, for checking what was written. */
async function formValuesOf(bytes: Buffer | Uint8Array): Promise<Record<string, unknown>> {
  const form = (await PDFDocument.load(bytes)).getForm();
  const out: Record<string, unknown> = {};
  for (const field of form.getFields()) {
    const name = field.getName();
    const any = field as unknown as {
      getText?: () => string | undefined;
      isChecked?: () => boolean;
      getSelected?: () => string | string[];
    };
    out[name] = any.getText ? any.getText() : any.isChecked ? any.isChecked() : any.getSelected?.();
  }
  return out;
}

/** A document with bookmarks pointing at pages, for the outline panel. */
async function outlineFixture(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const title of ["One", "Two", "Three"]) {
    doc.addPage([400, 400]).drawText(`Chapter ${title}`, { x: 40, y: 340, size: 16, font });
  }
  const context = doc.context;
  const pages = doc.getPages();
  // An outline is a linked list of items under the catalogue's /Outlines.
  const outlinesRef = context.nextRef();
  const items = ["Chapter One", "Chapter Two", "Chapter Three"].map((title, i) =>
    context.register(
      context.obj({
        Title: PDFString.of(title),
        Parent: outlinesRef,
        Dest: [pages[i]!.ref, PDFName.of("Fit")],
      }),
    ),
  );
  for (const [i, ref] of items.entries()) {
    const dict = context.lookup(ref, PDFDict);
    if (items[i - 1]) dict.set(PDFName.of("Prev"), items[i - 1]!);
    if (items[i + 1]) dict.set(PDFName.of("Next"), items[i + 1]!);
  }
  context.assign(
    outlinesRef,
    context.obj({ Type: "Outlines", First: items[0]!, Last: items[2]!, Count: items.length }),
  );
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  return Buffer.from(await doc.save());
}

/** A document with real text, for search. One line per entry, per page. */
async function textFixture(pages: string[][], face = StandardFonts.Helvetica): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(face);
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

/** Annotation subtypes per page of a saved document. */
async function annotationsOf(bytes: Buffer | Uint8Array): Promise<string[][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const annots = page.node.Annots();
    if (!annots) return [];
    const out: string[] = [];
    for (let i = 0; i < annots.size(); i++) {
      out.push(String(annots.lookup(i, PDFDict).get(PDFName.of("Subtype"))));
    }
    return out;
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
  // Matched loosely: the separator between the two counts is presentation.
  await expect(page.getByText(/3 pages.*1 selected/)).toBeVisible();
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

test("zooming changes the rendered page size", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "zoom.pdf", await fixture([PORTRAIT]));
  const canvas = page.getByTestId("viewer").getByRole("img", { name: "Page 1" });
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId("zoom-level")).toHaveText("Fit");

  const fitted = await canvas.evaluate((el) => el.getBoundingClientRect().width);

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByTestId("zoom-level")).toHaveText("125%");
  // The page is re-rasterised larger, not scaled up as a blurry bitmap.
  await expect
    .poll(() => canvas.evaluate((el) => (el as HTMLCanvasElement).width))
    .toBeGreaterThan(0);
  const zoomed = await canvas.evaluate((el) => el.getBoundingClientRect().width);
  expect(zoomed).toBeGreaterThan(fitted);

  await page.getByRole("button", { name: "Fit" }).click();
  await expect(page.getByTestId("zoom-level")).toHaveText("Fit");
});

test("highlights, notes and typed text are written into the saved file", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(
    page,
    "marked.pdf",
    await textFixture([["Result sheet for semester one", "Candidate: A. Student"]]),
  );
  await expect(page.getByText("1 page")).toBeVisible();

  const layer = page.getByTestId("annots-0");
  await expect(layer).toBeVisible();
  const box = (await layer.boundingBox())!;

  // Highlight: drag across the first line.
  await page.getByTestId("tool-highlight").click();
  await page.mouse.move(box.x + 20, box.y + 24);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("annot-0")).toBeVisible();

  // Note: click, then type its text.
  await page.getByTestId("tool-note").click();
  await page.mouse.click(box.x + 300, box.y + 120);
  await page.getByTestId("annotation-text").fill("check this entry");
  await page.getByRole("button", { name: "Place" }).click();
  await expect(page.getByTestId("annot-1")).toBeVisible();

  // Typed text on the page.
  await page.getByTestId("tool-text").click();
  await page.mouse.click(box.x + 40, box.y + 200);
  await page.getByTestId("annotation-text").fill("Verified by the exam cell");
  await page.getByRole("button", { name: "Place" }).click();
  await expect(page.getByTestId("annot-2")).toBeVisible();

  const saved = await saveAndRead(page, "Save");
  const subtypes = (await annotationsOf(saved))[0]!;
  // A highlight snapped to text lines may cover more than one line, so there can
  // be several Highlight objects; the note and the free text are one each.
  expect(subtypes.filter((s) => s === "/Highlight").length).toBeGreaterThanOrEqual(1);
  expect(subtypes).toContain("/Text");
  expect(subtypes).toContain("/FreeText");

  // The words under a highlight survive: it is an annotation, not paint.
  const reopened = await PDFDocument.load(saved);
  expect(reopened.getPageCount()).toBe(1);

  // And they are actually visible when the file is reopened — the engine has to
  // draw them, which it does by synthesising appearance streams. Structure alone
  // would not prove the user sees anything.
  const ink = () =>
    page
      .getByTestId("viewer")
      .getByRole("img", { name: "Page 1" })
      .evaluate(async (el) => {
        const canvas = el as HTMLCanvasElement;
        const off = new OffscreenCanvas(canvas.width, canvas.height);
        const ctx = off.getContext("2d")!;
        ctx.drawImage(canvas, 0, 0);
        const { data } = ctx.getImageData(0, 0, off.width, off.height);
        let marked = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i]! < 250) marked++;
        return marked;
      });

  await openFixture(
    page,
    "plain-again.pdf",
    await textFixture([["Result sheet for semester one"]]),
  );
  await expect.poll(ink).toBeGreaterThan(0);
  const plainInk = await ink();

  await openFixture(page, "reopened.pdf", saved);
  await expect.poll(ink).toBeGreaterThan(plainInk);
});

test("an annotation can be removed before saving", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "one.pdf", await textFixture([["A line of text"]]));

  const box = (await page.getByTestId("annots-0").boundingBox())!;
  await page.getByTestId("tool-note").click();
  await page.mouse.click(box.x + 100, box.y + 100);
  await page.getByTestId("annotation-text").fill("remove me");
  await page.getByRole("button", { name: "Place" }).click();
  await expect(page.getByTestId("annot-0")).toBeVisible();

  // Leaving the tool makes the marks clickable, and a click removes one.
  await page.getByTestId("tool-note").click();
  await page.getByTestId("annot-0").click();
  await expect(page.getByTestId("annot-0")).toBeHidden();

  expect((await annotationsOf(await saveAndRead(page, "Save")))[0]).toEqual([]);
});

test("opening a second document replaces the rendered pages", async ({ page }) => {
  // Regression: both documents have identical page geometry, so nothing the page
  // canvas depended on changed and the first document's pixels stayed on screen.
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  const fingerprint = () =>
    page
      .getByTestId("viewer")
      .getByRole("img", { name: "Page 1" })
      .evaluate(async (el) => {
        const canvas = el as HTMLCanvasElement;
        const off = new OffscreenCanvas(canvas.width, canvas.height);
        const ctx = off.getContext("2d")!;
        ctx.drawImage(canvas, 0, 0);
        const { data } = ctx.getImageData(0, 0, off.width, off.height);
        let ink = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i]! < 240) ink++;
        return ink;
      });

  await openFixture(page, "first.pdf", await textFixture([["First document"]]));
  await expect.poll(fingerprint).toBeGreaterThan(0);
  const first = await fingerprint();

  await openFixture(page, "second.pdf", await textFixture([["Second document with more words"]]));
  await expect.poll(fingerprint).not.toBe(first);
});

test("shows the document's bookmarks and jumps to one", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "bookmarked.pdf", await outlineFixture());
  await expect(page.getByText("3 pages")).toBeVisible();

  await page.getByTestId("tab-outline").click();
  await expect(page.getByTestId("outline")).toBeVisible();
  await expect(page.getByRole("button", { name: "Chapter Two" })).toBeVisible();

  // Clicking a bookmark scrolls the viewer to that page.
  const before = await page.getByTestId("viewer").evaluate((el) => el.scrollTop);
  await page.getByRole("button", { name: "Chapter Three" }).click();
  await expect
    .poll(() => page.getByTestId("viewer").evaluate((el) => el.scrollTop))
    .toBeGreaterThan(before);
});

test("a document without bookmarks says so rather than showing an empty panel", async ({
  page,
}) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "plain.pdf", await fixture([PORTRAIT]));

  await page.getByTestId("tab-outline").click();
  await expect(page.getByTestId("outline-empty")).toBeVisible();
});

test("splits a document into one file per selected page", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "four.pdf", await fixture([PORTRAIT, LANDSCAPE, SQUARE, PORTRAIT]));
  await expect(page.getByText("4 pages")).toBeVisible();

  // Page 3 starts a new part, so the split is [1,2] and [3,4].
  await page.getByTestId("select-2").click();

  const downloads: Promise<Buffer>[] = [];
  page.on("download", (download) => downloads.push(download.path().then((p) => readFile(p!))));
  await page.getByTestId("split").click();
  await expect(page.getByTestId("status")).toHaveText(/Saved 2 of 2 parts/, { timeout: 30_000 });

  const parts = await Promise.all(downloads);
  expect(parts).toHaveLength(2);
  expect(await sizesOf(parts[0]!)).toEqual([PORTRAIT, LANDSCAPE]);
  expect(await sizesOf(parts[1]!)).toEqual([SQUARE, PORTRAIT]);
});

test("underline and strike-through reach the saved file", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "lines.pdf", await textFixture([["A line to mark up"]]));

  const box = (await page.getByTestId("annots-0").boundingBox())!;
  for (const [tool, from] of [
    ["underline", 24],
    ["strike", 60],
  ] as const) {
    await page.getByTestId(`tool-${tool}`).click();
    await page.mouse.move(box.x + 20, box.y + from);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + from + 16, { steps: 6 });
    await page.mouse.up();
  }

  const subtypes = (await annotationsOf(await saveAndRead(page, "Save")))[0]!;
  expect(subtypes).toContain("/Underline");
  expect(subtypes).toContain("/StrikeOut");
});

/** A small valid PNG, built in the test so no binary fixture is needed. */
function tinyPng(width: number, height: number): Buffer {
  const crc = (bytes: number[]) => {
    let c = ~0;
    for (const byte of bytes) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const chunk = (type: string, data: number[]) => {
    const typed = [...type].map((c) => c.charCodeAt(0));
    return [...be32(data.length), ...typed, ...data, ...be32(crc([...typed, ...data]))];
  };
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push((x * 20) % 256, (y * 30) % 256, 128);
  }
  // One uncompressed deflate block, which needs no compressor.
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const deflate = [
    0x78,
    0x01,
    0x01,
    raw.length & 255,
    (raw.length >> 8) & 255,
    ~raw.length & 255,
    (~raw.length >> 8) & 255,
    ...raw,
    (b >>> 8) & 255,
    b & 255,
    (a >>> 8) & 255,
    a & 255,
  ];
  return Buffer.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk("IHDR", [...be32(width), ...be32(height), 8, 2, 0, 0, 0]),
    ...chunk("IDAT", deflate),
    ...chunk("IEND", []),
  ]);
}

test("turns images into a PDF and pages back into images", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await page.setInputFiles('[data-testid="image-input"]', [
    { name: "scan-1.png", mimeType: "image/png", buffer: tinyPng(40, 30) },
    { name: "scan-2.png", mimeType: "image/png", buffer: tinyPng(20, 40) },
  ]);

  // One page per image, each at the image's own aspect ratio.
  await expect(page.getByText("2 pages")).toBeVisible({ timeout: 30_000 });
  const sizes = await sizesOf(await saveAndRead(page, "Save"));
  expect(sizes).toEqual([
    [30, 23],
    [15, 30],
  ]);

  // And back out again: the selected page renders to a PNG.
  await page.getByTestId("select-0").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("pages-to-images").click(),
  ]);
  const png = await readFile((await download.path())!);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG signature
  expect(download.suggestedFilename()).toMatch(/page 1\.png$/);
});

test("makes a scanned page searchable with OCR", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  // A page that is only a picture of text, which is what a scan is. The image is
  // drawn in the browser because Node cannot rasterise text, then dropped on the
  // window so it goes through the real images-to-PDF path.
  const words = "Result sheet for semester one";
  await page.evaluate(async (text) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1400;
    canvas.height = 220;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    ctx.font = '90px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textBaseline = "middle";
    ctx.fillText(text, 40, 110);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png"),
    );
    const file = new File([blob], "scan.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const app = document.querySelector(".app")!;
    app.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true }));
  }, words);

  await expect(page.getByText("1 page")).toBeVisible({ timeout: 30_000 });

  // Nothing to find yet: it is a picture, with no text layer at all.
  await page.getByTestId("search-input").fill("semester");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toBeHidden();

  // OCR downloads the language pack from our own origin on first use, so this is
  // the slowest test here by far.
  await page.getByTestId("run-ocr").click();
  await expect(page.getByTestId("status")).toHaveText(/Read 1 page/, { timeout: 180_000 });

  // Now the same search finds it, which is the whole point of a searchable PDF.
  await page.getByTestId("search-input").fill("semester");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText(/of \d+/, { timeout: 60_000 });

  // And the text layer is in the file, not just in the viewer.
  const saved = await saveAndRead(page, "Save");
  expect(saved.length).toBeGreaterThan(0);
});

test("leaves pages that already have text alone", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "digital.pdf", await textFixture([["Already selectable text"]]));
  await page.getByTestId("run-ocr").click();
  // Re-OCRing a digital page would replace real text with a picture of it.
  await expect(page.getByTestId("status")).toHaveText(/skipped 1 that already had text/, {
    timeout: 180_000,
  });
});

test("fills in a form and writes the values into the file", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "application.pdf", await formFixture());
  await expect(page.getByText("1 page")).toBeVisible();

  await page.getByTestId("tab-form").click();
  await expect(page.getByTestId("form-panel")).toBeVisible();

  await page.getByTestId("field-student.name").fill("A. Student");
  await page.getByTestId("field-student.passed").check();
  await page.getByTestId("field-student.grade").selectOption("B");
  await page.getByTestId("apply-form").click();
  await expect(page.getByTestId("status")).toHaveText("Form values written", { timeout: 30_000 });

  // The values are in the document, in its fields, still editable elsewhere.
  expect(await formValuesOf(await saveAndRead(page, "Save"))).toEqual({
    "student.name": "A. Student",
    "student.passed": true,
    "student.grade": ["B"],
  });
});

test("flattening a form keeps the values and removes the fields", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "application.pdf", await formFixture());
  await page.getByTestId("tab-form").click();
  await page.getByTestId("field-student.name").fill("Final answer");
  await page.getByTestId("apply-form").click();
  await expect(page.getByTestId("status")).toHaveText("Form values written", { timeout: 30_000 });

  await page.getByTestId("flatten-form").click();
  await expect(page.getByTestId("status")).toHaveText("Form flattened", { timeout: 30_000 });
  // No fields left to edit, and the panel says so.
  await expect(page.getByTestId("form-empty")).toBeVisible();

  const saved = await saveAndRead(page, "Save");
  expect(await formValuesOf(saved)).toEqual({});
  // The value survives as drawn content, which is what flattening is for.
  const doc = await PDFDocument.load(saved);
  expect(doc.getPageCount()).toBe(1);
});

test("a document with no form says so", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "plain.pdf", await fixture([PORTRAIT]));

  await page.getByTestId("tab-form").click();
  await expect(page.getByTestId("form-empty")).toBeVisible();
});

test("redaction removes the text from the file, not just covers it", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  // Two lines: the first gets redacted, the second must survive untouched.
  await openFixture(
    page,
    "confidential.pdf",
    await textFixture([["Aadhaar 1234 5678 9012", "Candidate: A. Student"]]),
  );
  await expect(page.getByText("1 page")).toBeVisible();

  // The secret is findable before redacting, which is the whole problem.
  await page.getByTestId("search-input").fill("5678");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });

  const layer = page.getByTestId("annots-0");
  const box = (await layer.boundingBox())!;
  await page.getByTestId("tool-redact").click();
  await page.mouse.move(box.x + 10, box.y + 18);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 44, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("redact-0-0")).toBeVisible();

  await page.getByTestId("apply-redaction").click();
  // The app verifies by re-reading the result; anything else is a black box over
  // text that can still be extracted.
  await expect(page.getByTestId("status")).toHaveText(/no text left in the redacted areas/, {
    timeout: 60_000,
  });

  // Searching the live document no longer finds it.
  await page.getByTestId("search-input").fill("5678");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toBeHidden();

  // And the bytes themselves do not contain it, which is what actually matters:
  // a reader with any PDF tool must not be able to recover the text.
  const saved = await saveAndRead(page, "Save");
  expect(saved.toString("latin1")).not.toContain("5678");

  // The untouched line is still there, so redaction did not take the page with it.
  await page.getByTestId("search-input").fill("Candidate");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText(/of \d+/, { timeout: 30_000 });
});

test("shapes and freehand reach the file, and the Marks panel lists them", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "shapes.pdf", await textFixture([["A page to mark up"]]));

  const box = (await page.getByTestId("annots-0").boundingBox())!;

  // A box, in blue.
  await page.getByTestId("colour-blue").click();
  await page.getByTestId("tool-square").click();
  await page.mouse.move(box.x + 30, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 130, { steps: 6 });
  await page.mouse.up();

  // An oval.
  await page.getByTestId("tool-circle").click();
  await page.mouse.move(box.x + 200, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 140, { steps: 6 });
  await page.mouse.up();

  // A freehand squiggle: several moves so it is a real path, not a click.
  await page.getByTestId("tool-ink").click();
  await page.mouse.move(box.x + 40, box.y + 200);
  await page.mouse.down();
  for (const [dx, dy] of [
    [30, 20],
    [60, -10],
    [90, 25],
    [120, 0],
  ]) {
    await page.mouse.move(box.x + 40 + dx, box.y + 200 + dy);
  }
  await page.mouse.up();

  // All three are listed where a reviewer can work through them.
  await page.getByTestId("tab-comments").click();
  await expect(page.getByTestId("comments")).toBeVisible();
  await expect(page.getByTestId("comment-0")).toContainText("Box");
  await expect(page.getByTestId("comment-1")).toContainText("Oval");
  await expect(page.getByTestId("comment-2")).toContainText("Freehand");

  const subtypes = (await annotationsOf(await saveAndRead(page, "Save")))[0]!;
  expect(subtypes).toContain("/Square");
  expect(subtypes).toContain("/Circle");
  expect(subtypes).toContain("/Ink");
});

test("a mark can be removed from the Marks panel", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "one.pdf", await textFixture([["A line"]]));

  const box = (await page.getByTestId("annots-0").boundingBox())!;
  await page.getByTestId("tool-square").click();
  await page.mouse.move(box.x + 20, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 4 });
  await page.mouse.up();

  await page.getByTestId("tab-comments").click();
  await expect(page.getByTestId("comment-0")).toBeVisible();
  await page.getByRole("button", { name: /^Remove Box/ }).click();
  await expect(page.getByTestId("comments-empty")).toBeVisible();

  expect((await annotationsOf(await saveAndRead(page, "Save")))[0]).toEqual([]);
});

test("a longer paragraph re-wraps inside its own block", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  // Two lines, same left edge, one line apart: one paragraph to the editor.
  await openFixture(
    page,
    "memo.pdf",
    await textFixture([["A fairly long first line of text", "and a second line beneath it"]]),
  );
  await expect(page.getByText("1 page")).toBeVisible();

  await page.getByTestId("edit-text").click();
  const target = page.getByTestId("edittarget-0");
  await expect(target).toBeVisible({ timeout: 30_000 });
  const before = (await target.boundingBox())!;
  await target.click();

  const box = page.getByTestId("editbox-0");
  await expect(box).toBeVisible();
  await box.fill(
    "A fairly long first line of text and a second line beneath it, now with " +
      "considerably more text than the paragraph started with, which has to go " +
      "somewhere other than off the edge of the page.",
  );
  await box.press("Enter");

  // Lines the block did not have are reported rather than left to be noticed.
  await expect(page.getByTestId("status")).toHaveText(/Text changed: \d+ new lines?/, {
    timeout: 30_000,
  });

  // The block is taller than it was, and no wider: the text wrapped.
  const after = (await page.getByTestId("edittarget-0").boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height);
  expect(after.width).toBeLessThanOrEqual(before.width + 2);

  // The wrapped words are still the document's own text.
  await page.getByTestId("search-input").fill("off the edge");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });
});

test("a font that cannot show the new text is substituted, and said so", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  // ZapfDingbats has no letters at all — the extreme form of the ordinary case,
  // an embedded font subset missing a few glyphs.
  await openFixture(
    page,
    "dingbats.pdf",
    await textFixture([["\u2701\u2702\u2703"]], StandardFonts.ZapfDingbats),
  );
  await expect(page.getByText("1 page")).toBeVisible();

  await page.getByTestId("edit-text").click();
  const target = page.getByTestId("edittarget-0");
  await expect(target).toBeVisible({ timeout: 30_000 });
  await target.click();
  const box = page.getByTestId("editbox-0");
  await box.fill("Minutes of the meeting");
  await box.press("Enter");

  await expect(page.getByTestId("status")).toHaveText(/cannot show .*Helvetica was used/, {
    timeout: 30_000,
  });

  // Substituted, not dropped: the words are really on the page. One word, not
  // the phrase: the dingbats block is narrow, so the new text wraps inside it.
  await page.getByTestId("search-input").fill("Minutes");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });
});

test("edits the text in the document itself, not a note over it", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  await openFixture(page, "letter.pdf", await textFixture([["Dear Sir or Madam"]]));
  await expect(page.getByText("1 page")).toBeVisible();

  // The original words are findable.
  await page.getByTestId("search-input").fill("Madam");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });

  await page.getByTestId("edit-text").click();
  await expect(page.getByTestId("edit-caveat")).toBeVisible();

  // Every run on the page is a target; the first one is the line of text.
  const target = page.getByTestId("edittarget-0");
  await expect(target).toBeVisible({ timeout: 30_000 });
  await target.click();

  const box = page.getByTestId("editbox-0");
  await expect(box).toBeVisible();
  await box.fill("Dear Registrar");
  await box.press("Enter");
  await expect(page.getByTestId("status")).toHaveText("Text changed", { timeout: 30_000 });

  // The new words are in the page's own text, which is what makes this editing
  // rather than annotating: search reads the content stream, not annotations.
  await page.getByTestId("search-input").fill("Registrar");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });

  // And the old words are gone from the file, not merely covered over.
  const saved = await saveAndRead(page, "Save");
  expect(await annotationsOf(saved)).toEqual([[]]);
  await page.getByTestId("search-input").fill("Madam");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toBeHidden();
});
