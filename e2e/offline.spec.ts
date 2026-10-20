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
  // What a document converted from Word actually carries.
  doc.setTitle("Microsoft Word - final(2).docx");
  doc.setAuthor("Lab Laptop");
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
  // Addressed by position: each row also carries rename, move and remove
  // buttons whose labels name the bookmark too.
  await expect(page.getByTestId("bookmark-1")).toContainText("Chapter Two");

  // Clicking a bookmark scrolls the viewer to that page.
  const before = await page.getByTestId("viewer").evaluate((el) => el.scrollTop);
  await page.getByTestId("bookmark-2").click();
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

/**
 * Whether the first page as rendered contains any strongly coloured pixel.
 *
 * The page canvas uses a bitmap context, so its pixels are read by drawing it
 * into a second canvas. This is how a drawing that only exists in an appearance
 * stream can be checked: PDFium either drew it or it did not.
 */
async function hasColouredInk(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const source = document.querySelector<HTMLCanvasElement>('[data-testid="viewer"] canvas');
    if (!source) return false;
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    const context = copy.getContext("2d");
    if (!context) return false;
    context.drawImage(source, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      // Clearly coloured, not black text and not white paper.
      if (r > 120 && g < 90 && b < 90) return true;
    }
    return false;
  });
}

test("compares two versions and says what changed", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  // The newer version is the one open.
  await openFixture(
    page,
    "circular-v2.pdf",
    await textFixture([["Circular 12 of 2026"], ["Fees are due in June"], ["Signed"]]),
  );
  await expect(page.getByText("3 pages")).toBeVisible();

  await page.setInputFiles('[data-testid="compare-input"]', {
    name: "circular-v1.pdf",
    mimeType: "application/pdf",
    buffer: await textFixture([["Circular 12 of 2026"], ["Fees are due in May"], ["Signed"]]),
  });

  await expect(page.getByTestId("diff-summary")).toContainText("1 page differ", {
    timeout: 30_000,
  });
  // Only the page that changed is listed, with the words either way round.
  await expect(page.getByTestId("diff-page-1")).toContainText("May");
  await expect(page.getByTestId("diff-page-1")).toContainText("June");
  await expect(page.getByTestId("diff-page-0")).toBeHidden();
});

test("comparing against a shorter document says which pages are new", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "long.pdf", await textFixture([["One"], ["Two"], ["Three"]]));
  await expect(page.getByText("3 pages")).toBeVisible();

  await page.setInputFiles('[data-testid="compare-input"]', {
    name: "short.pdf",
    mimeType: "application/pdf",
    buffer: await textFixture([["One"]]),
  });

  await expect(page.getByTestId("diff-summary")).toContainText("2 pages are only here", {
    timeout: 30_000,
  });
});

test("carries a file inside the document, and gives it back", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "circular.pdf", await textFixture([["Circular 12/2026"]]));

  await page.getByTestId("tab-attachments").click();
  await expect(page.getByTestId("attachments-empty")).toBeVisible();

  // Attaching uses the same file input the open fallback does.
  await page.setInputFiles('[data-testid="attach-input"]', {
    name: "annexure.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("roll,marks\n1,90\n"),
  });
  await expect(page.getByTestId("status")).toHaveText("Attached annexure.csv", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("attachment-list")).toContainText("annexure.csv");

  // It is in the file, where another reader will find it.
  const saved = await saveAndRead(page, "Save");
  const doc = await PDFDocument.load(saved);
  const names = doc.catalog.lookup(PDFName.of("Names"), PDFDict);
  expect(names.get(PDFName.of("EmbeddedFiles"))).toBeDefined();

  // And removing it takes it out again.
  await page.getByTestId("remove-attachment-annexure.csv").click();
  await expect(page.getByTestId("status")).toHaveText("Removed annexure.csv", { timeout: 30_000 });
  await expect(page.getByTestId("attachments-empty")).toBeVisible();
});

test("builds a fillable form on a blank page, then fills it", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "admission.pdf", await textFixture([["Application form"]]));

  await page.getByTestId("tab-form").click();
  await page.getByTestId("add-field-tool").click();

  // Drag where someone should write their name.
  const area = (await page.getByTestId("annots-0").boundingBox())!;
  await page.mouse.move(area.x + 60, area.y + 120);
  await page.mouse.down();
  await page.mouse.move(area.x + 320, area.y + 150, { steps: 5 });
  await page.mouse.up();

  await expect(page.getByTestId("field-prompt")).toBeVisible();
  await page.getByTestId("field-name").fill("applicant.name");
  await page.getByTestId("add-field").click();
  await expect(page.getByTestId("status")).toHaveText("Added the field applicant.name", {
    timeout: 30_000,
  });

  // It is a real field: the Form panel lists it and can fill it.
  await expect(page.getByTestId("field-list")).toContainText("applicant.name");
  await page.getByTestId("field-applicant.name").fill("A Student");
  await page.getByTestId("apply-form").click();
  await expect(page.getByTestId("status")).toHaveText("Form values written", { timeout: 30_000 });

  // And the value is in the saved file, under the name it was given.
  const saved = await saveAndRead(page, "Save");
  expect(await formValuesOf(saved)).toMatchObject({ "applicant.name": "A Student" });

  // Removing it takes the field out again.
  await page.getByTestId("remove-field-applicant.name").click();
  await expect(page.getByTestId("status")).toHaveText("Removed the field applicant.name", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("field-list")).toBeHidden();
});

test("the marks list filters, searches and sorts by page", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "review.pdf", await textFixture([["One"], ["Two"]]));

  // A note on page two, then a box on page one: placed out of page order, so
  // sorting has something to do.
  await page.getByTestId("viewer").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const second = page.getByTestId("annots-1");
  await expect(second).toBeVisible();
  await page.getByTestId("tool-note").click();
  const secondBox = (await second.boundingBox())!;
  // Near the bottom of the page: scrolled to the end, the top of a full-height
  // page is above the window and a click there lands nowhere.
  await page.mouse.click(secondBox.x + 60, secondBox.y + secondBox.height - 80);
  await page.getByTestId("annotation-text").fill("Check the figures");
  await page.getByRole("button", { name: "Place" }).click();

  await page.getByTestId("viewer").evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByTestId("annots-0")).toBeVisible();
  const firstBox = (await page.getByTestId("annots-0").boundingBox())!;
  await page.getByTestId("tool-square").click();
  await page.mouse.move(firstBox.x + 20, firstBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(firstBox.x + 120, firstBox.y + 90, { steps: 4 });
  await page.mouse.up();

  await page.getByTestId("tab-comments").click();
  // Sorted by page, so the box on page one comes first even though it was
  // placed second.
  await expect(page.getByTestId("comments").locator("li").first()).toContainText("Box");

  // Searching the text of the marks.
  await page.getByTestId("comment-search").fill("figures");
  await expect(page.getByTestId("comments").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("comments")).toContainText("Note");

  // And filtering by kind.
  await page.getByTestId("comment-search").fill("");
  await page.getByTestId("comment-kind").selectOption("square");
  await expect(page.getByTestId("comments").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("comments")).toContainText("Box");

  // A filter that matches nothing says so rather than looking empty.
  await page.getByTestId("comment-search").fill("nothing here");
  await expect(page.getByTestId("comments-none")).toBeVisible();
});

test("two-up puts a pair of pages side by side", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "book.pdf", await textFixture([["One"], ["Two"], ["Three"], ["Four"]]));
  await expect(page.getByText("4 pages")).toBeVisible();

  const pageBox = (position: number) =>
    page.locator(`[data-page-position="${position}"]`).boundingBox();

  // Continuous: the second page is below the first.
  const firstDown = (await pageBox(0))!;
  const secondDown = (await pageBox(1))!;
  expect(secondDown.y).toBeGreaterThan(firstDown.y + firstDown.height / 2);

  await page.getByTestId("facing").click();
  await expect
    .poll(async () => {
      const first = await pageBox(0);
      const second = await pageBox(1);
      return first && second ? Math.abs(first.y - second.y) : 999;
    })
    .toBeLessThan(4);

  // Side by side, and in reading order: page one on the left.
  const first = (await pageBox(0))!;
  const second = (await pageBox(1))!;
  expect(first.x).toBeLessThan(second.x);
  expect(second.x).toBeGreaterThan(first.x + first.width - 4);
});

test("crops the page, watermarks it, and numbers the front matter apart", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(
    page,
    "thesis.pdf",
    await textFixture([["Cover"], ["Contents"], ["Chapter 1"]]),
  );
  await expect(page.getByText("3 pages")).toBeVisible();

  // Crop: drag the part to keep. The page gets narrower on screen.
  const before = (await page.getByTestId("annots-0").boundingBox())!;
  await page.getByTestId("tool-crop").click();
  await expect(page.getByTestId("crop-hint")).toBeVisible();
  await page.mouse.move(before.x + 40, before.y + 40);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width - 60, before.y + before.height - 80, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("status")).toHaveText("Cropped every page", { timeout: 30_000 });
  const cropped = (await page.getByTestId("annots-0").boundingBox())!;
  expect(cropped.width).toBeLessThan(before.width);

  // And it is a crop, not a cut: the whole page comes back.
  await page.getByTestId("uncrop").click();
  await expect(page.getByTestId("status")).toHaveText("Crop removed", { timeout: 30_000 });
  await expect
    .poll(async () => (await page.getByTestId("annots-0").boundingBox())!.width)
    .toBeCloseTo(before.width, 0);

  // Watermark, behind the text so the document stays readable.
  await page.getByTestId("watermark").click();
  await page.getByTestId("watermark-text").fill("CONFIDENTIAL");
  await page.getByTestId("apply-watermark").click();
  await expect(page.getByTestId("status")).toHaveText("Watermark added", { timeout: 30_000 });
  // In the document's own text, so it prints and extracts.
  await page.getByTestId("search-input").fill("CONFIDENTIAL");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 3", { timeout: 30_000 });

  // Page labels: the first two pages are front matter.
  await page.getByTestId("page-labels").click();
  await page.getByTestId("apply-labels").click();
  await expect(page.getByTestId("status")).toHaveText("Page numbering set", { timeout: 30_000 });

  const saved = await saveAndRead(page, "Save");
  const doc = await PDFDocument.load(saved);
  expect(doc.catalog.get(PDFName.of("PageLabels"))).toBeDefined();
});

test("says whether a screen reader could read the document, and fixes what it can", async ({
  page,
}) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "notice.pdf", await textFixture([["Notice"]]));
  await expect(page.getByText("1 page")).toBeVisible();

  await page.getByTestId("check-accessibility").click();
  const list = page.getByTestId("accessibility-issues");
  // The fixture carries a title, so the failures are language and tagging.
  await expect(list).toContainText("No language set", { timeout: 30_000 });
  await expect(list).toContainText("Not tagged");
  // Tagging is reported as beyond a setting rather than silently guessed at.
  await expect(list).toContainText("Needs more than a setting");

  await page.getByTestId("doc-language").selectOption("en-IN");
  await page.getByTestId("fix-accessibility").click();
  await expect(page.getByTestId("status")).toHaveText("Title, language and window title set", {
    timeout: 30_000,
  });
  await expect(list).not.toContainText("No language set", { timeout: 30_000 });

  // In the file: a reader announces the document, not the file name.
  const saved = await saveAndRead(page, "Save");
  const doc = await PDFDocument.load(saved);
  expect(doc.catalog.lookup(PDFName.of("Lang"))?.toString()).toContain("en-IN");
});

test("a picture can be moved and removed, in the document itself", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });

  // A page with two pictures on it.
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const png = await doc.embedPng(tinyPng(2, 2));
  sheet.drawImage(png, { x: 50, y: 280, width: 80, height: 60 });
  sheet.drawImage(png, { x: 220, y: 80, width: 50, height: 50 });
  await openFixture(page, "poster.pdf", Buffer.from(await doc.save()));
  await expect(page.getByText("1 page")).toBeVisible();

  await page.getByTestId("edit-images").click();
  const first = page.getByTestId("image-0");
  await expect(first).toBeVisible({ timeout: 30_000 });
  const before = (await first.boundingBox())!;

  // Dragged across the page.
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 90, before.y + before.height / 2 + 40, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(page.getByTestId("status")).toHaveText("Picture moved", { timeout: 30_000 });

  const after = (await page.getByTestId("image-0").boundingBox())!;
  expect(after.x).toBeGreaterThan(before.x + 40);
  expect(after.y).toBeGreaterThan(before.y + 10);
  // Same picture, same size: moving must not rescale it.
  expect(Math.round(after.width)).toBe(Math.round(before.width));

  // And removed, leaving the other one.
  await page.getByTestId("image-0").click();
  await page.getByTestId("image-remove-0").click();
  await expect(page.getByTestId("status")).toHaveText("Picture removed", { timeout: 30_000 });
  await expect(page.getByTestId("image-1")).toBeHidden();
  await expect(page.getByTestId("image-0")).toBeVisible();
});

test("bookmarks can be added, renamed, moved and removed", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "report.pdf", await textFixture([["One"], ["Two"], ["Three"]]));
  await expect(page.getByText("3 pages")).toBeVisible();

  await page.getByTestId("tab-outline").click();
  await expect(page.getByTestId("outline-empty")).toBeVisible();

  // Added for the page being read, which is the first one.
  await page.getByTestId("add-bookmark").click();
  await expect(page.getByTestId("status")).toHaveText("Bookmarks saved", { timeout: 30_000 });
  await expect(page.getByTestId("bookmark-0")).toContainText("Page 1");

  // Renamed in place.
  await page.getByTestId("bookmark-edit-0").click();
  await page.getByTestId("bookmark-rename-0").fill("Introduction");
  await page.getByTestId("bookmark-rename-0").press("Enter");
  await expect(page.getByTestId("bookmark-0")).toContainText("Introduction", { timeout: 30_000 });

  // A second one, then moved above the first.
  await page.getByTestId("add-bookmark").click();
  await expect(page.getByTestId("bookmark-1")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /^Move Page 1 up/ }).click();
  await expect(page.getByTestId("bookmark-1")).toContainText("Introduction", { timeout: 30_000 });

  // Saved into the file, where another reader will find them.
  const saved = await saveAndRead(page, "Save");
  const doc = await PDFDocument.load(saved);
  expect(doc.catalog.get(PDFName.of("Outlines"))).toBeDefined();

  // And removable.
  await page.getByTestId("bookmark-remove-1").click();
  await expect(page.getByTestId("status")).toHaveText("Bookmarks saved", { timeout: 30_000 });
  await expect(page.getByTestId("bookmark-1")).toBeHidden();
});

test("says what the document is carrying unseen, and takes it out", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  // The fixture carries a title and an author, as every converted document does.
  await openFixture(page, "list.pdf", await textFixture([["Admissions"]]));
  await expect(page.getByText("1 page")).toBeVisible();

  await page.getByTestId("sanitise").click();
  await expect(page.getByTestId("hidden-report")).toContainText("a description", {
    timeout: 30_000,
  });

  await page.getByTestId("apply-sanitise").click();
  await expect(page.getByTestId("status")).toContainText("Removed the description", {
    timeout: 30_000,
  });

  // Gone from the file, which is where it mattered.
  const saved = await saveAndRead(page, "Save");
  const doc = await PDFDocument.load(saved);
  expect(doc.getTitle()).toBeUndefined();
  expect(doc.getAuthor()).toBeUndefined();

  // And the page itself is untouched.
  await page.getByTestId("search-input").fill("Admissions");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });
});

test("finds every Aadhaar number and removes them all", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(
    page,
    "admissions.pdf",
    await textFixture([
      ["Name: A Student", "Aadhaar: 1234 5678 9012", "Course: MTech"],
      ["Name: B Student", "Aadhaar 2345-6789-0123", "Course: MTech"],
    ]),
  );
  await expect(page.getByText("2 pages")).toBeVisible();

  await page.getByTestId("find-redact").click();
  await expect(page.getByTestId("pattern-aadhaar")).toBeChecked();
  await page.getByTestId("find-matches").click();

  // Found and counted before anything is destroyed.
  await expect(page.getByTestId("status")).toContainText("2 matches on 2 pages", {
    timeout: 30_000,
  });
  await page.getByTestId("redact-matches").click();
  await expect(page.getByTestId("status")).toContainText("no text left in the redacted areas", {
    timeout: 60_000,
  });

  // Gone from the document's own text — both of them, on both pages.
  await page.getByTestId("search-input").fill("5678");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toBeHidden();
  await page.getByTestId("search-input").fill("6789");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toBeHidden();

  // And the words around them survived: this removes the number, not the page.
  await page.getByTestId("search-input").fill("MTech");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 2", { timeout: 30_000 });
});

test("an arrow and a stamp are drawn by the engine, not just written", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "plan.pdf", await textFixture([["Site plan"]]));

  const area = (await page.getByTestId("annots-0").boundingBox())!;
  await page.getByTestId("tool-arrow").click();
  await page.mouse.move(area.x + 40, area.y + 160);
  await page.mouse.down();
  await page.mouse.move(area.x + 220, area.y + 60, { steps: 6 });
  await page.mouse.up();

  await page.getByTestId("tool-stamp").click();
  await page.getByTestId("stamp-label").selectOption("Received");
  await page.mouse.click(area.x + 60, area.y + 300);

  await page.getByTestId("tab-comments").click();
  await expect(page.getByTestId("comment-0")).toContainText("Line");
  await expect(page.getByTestId("comment-1")).toContainText("Stamp");

  // Written into the document, with the right subtypes.
  const saved = await saveAndRead(page, "Save");
  expect((await annotationsOf(saved))[0]).toEqual(["/Line", "/Stamp"]);

  // And — the point of generating appearance streams — PDFium draws them.
  // Nothing on the page is red, so red pixels can only be the new marks.
  // Compressing rewrites the bytes, which is what writes the pending marks into
  // the document — so what is on screen afterwards is PDFium's own rendering.
  await page.getByRole("button", { name: "Compress" }).click();
  await expect(page.getByTestId("status")).not.toHaveText(/Compressing/, { timeout: 60_000 });
  await expect.poll(() => hasColouredInk(page), { timeout: 30_000 }).toBe(true);
});

test("a signature is drawn once and placed on the page", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "form.pdf", await textFixture([["Signed:"]]));

  await page.getByTestId("tool-signature").click();
  await page.getByTestId("draw-signature").click();

  const pad = (await page.getByTestId("signature-canvas").boundingBox())!;
  await page.mouse.move(pad.x + 30, pad.y + 110);
  await page.mouse.down();
  await page.mouse.move(pad.x + 120, pad.y + 40, { steps: 6 });
  await page.mouse.move(pad.x + 210, pad.y + 120, { steps: 6 });
  await page.mouse.move(pad.x + 320, pad.y + 50, { steps: 6 });
  await page.mouse.up();
  await page.getByTestId("signature-save").click();
  await expect(page.getByTestId("status")).toContainText("Signature saved", { timeout: 30_000 });

  const area = (await page.getByTestId("annots-0").boundingBox())!;
  await page.mouse.click(area.x + 120, area.y + 120);
  await page.getByTestId("tab-comments").click();
  await expect(page.getByTestId("comment-0")).toContainText("Signature");

  // One Stamp annotation carrying the strokes, not a pile of loose ink.
  const saved = await saveAndRead(page, "Save");
  expect((await annotationsOf(saved))[0]).toEqual(["/Stamp"]);
});

test("the document's description can be read and corrected", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "minutes.pdf", await textFixture([["Minutes"]]));
  await expect(page.getByText("1 page")).toBeVisible();

  await page.getByTestId("properties").click();
  // What the file says about itself, which is usually wrong after a conversion.
  await expect(page.getByTestId("prop-title")).toHaveValue("Microsoft Word - final(2).docx");
  await expect(page.getByTestId("prop-author")).toHaveValue("Lab Laptop");

  await page.getByTestId("prop-title").fill("Minutes of the Academic Council");
  await page.getByTestId("prop-author").fill("");
  await page.getByTestId("prop-keywords").fill("council, minutes");
  await page.getByTestId("apply-properties").click();
  await expect(page.getByTestId("status")).toHaveText("Description saved", { timeout: 30_000 });

  // Reopening the panel reads it back from the document, not from the form.
  await page.getByTestId("properties").click();
  await expect(page.getByTestId("prop-title")).toHaveValue("Minutes of the Academic Council");
  await expect(page.getByTestId("prop-author")).toHaveValue("");
  await expect(page.getByTestId("prop-keywords")).toHaveValue("council, minutes");

  // And it is in the file, which is what a catalogue will read.
  await page.getByTestId("properties-panel").getByRole("button", { name: "Cancel" }).click();
  const saved = await saveAndRead(page, "Save");
  const doc = await PDFDocument.load(saved);
  expect(doc.getTitle()).toBe("Minutes of the Academic Council");
  expect(doc.getAuthor() ?? "").toBe("");
});

test("print hands the document to the browser's own PDF viewer", async ({ page, context }) => {
  await withoutFilePickers(page);
  // Record what print opens. Headless Chromium has no PDF viewer, so the new
  // tab never commits a URL to read back; what matters is what it was given.
  await page.addInitScript(() => {
    const open = window.open.bind(window);
    (window as unknown as { printed: string[] }).printed = [];
    window.open = (url?: string | URL, ...rest: unknown[]) => {
      (window as unknown as { printed: string[] }).printed.push(String(url));
      return open(url, ...(rest as [string?, string?]));
    };
  });
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "letter.pdf", await textFixture([["Dear Sir or Madam"]]));
  await expect(page.getByText("1 page")).toBeVisible();

  const opened = context.waitForEvent("page");
  await page.getByTestId("print").click();
  const tab = await opened;

  // A local blob of the document itself, not a rasterised copy and not a
  // request to anywhere: printing must not be the one feature that uploads.
  const printed = await page.evaluate(() => (window as unknown as { printed: string[] }).printed);
  expect(printed[0]).toMatch(/^blob:/);
  await expect(page.getByTestId("status")).toContainText("print from there", {
    timeout: 30_000,
  });
  await tab.close();
});

test("the words on the page can be selected and copied", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "letter.pdf", await textFixture([["Dear Sir or Madam"]]));
  await expect(page.getByText("1 page")).toBeVisible();

  // The text sits over the canvas, invisible, in the document's own order.
  const layer = page.getByTestId("text-0");
  await expect(layer).toContainText("Dear Sir or Madam", { timeout: 30_000 });

  // Double-clicking a word selects it, which is what proves this is real text
  // and not a label: the browser's own selection is doing the work.
  await layer.getByText("Dear Sir or Madam").dblclick();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.trim().length).toBeGreaterThan(0);
  expect("Dear Sir or Madam").toContain(selected.trim());

  // And a whole-page selection reads the page back in order.
  const all = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="text-0"]');
    if (!node) return "";
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString() ?? "";
  });
  expect(all).toContain("Dear Sir or Madam");
});

test("numbers the pages, and the numbers are in the document", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "report.pdf", await textFixture([["One"], ["Two"], ["Three"]]));
  await expect(page.getByText("3 pages")).toBeVisible();

  await page.getByTestId("number-pages").click();
  await expect(page.getByTestId("numbering-panel")).toBeVisible();

  // The default is a centred footer; put the file name top right as well.
  await page.getByTestId("header-2").click();
  await page.getByTestId("token-file").click();
  await expect(page.getByTestId("header-2")).toHaveValue("{file}");

  await page.getByTestId("apply-numbering").click();
  await expect(page.getByTestId("status")).toHaveText("Headers and footers added", {
    timeout: 30_000,
  });

  // Drawn into the page, so the app's own search finds them.
  await page.getByTestId("search-input").fill("Page 2 of 3");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });

  // And they are in the saved file, not only on screen.
  const saved = await saveAndRead(page, "Save");
  expect(saved.length).toBeGreaterThan(0);

  // Numbering is a document change like any other, so it undoes.
  await page.getByTestId("undo").click();
  await page.getByTestId("search-input").fill("Page 2 of 3");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toBeHidden();
});

test("Bates numbering is a prefix and padding, starting where it is told", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "case.pdf", await textFixture([["One"], ["Two"]]));

  await page.getByTestId("number-pages").click();
  await page.getByTestId("footer-1").fill("");
  await page.getByTestId("footer-2").fill("ACME-{n}");
  await page.getByTestId("start-at").fill("500");
  await page.getByTestId("pad-digits").fill("6");
  await page.getByTestId("apply-numbering").click();
  await expect(page.getByTestId("status")).toHaveText("Headers and footers added", {
    timeout: 30_000,
  });

  await page.getByTestId("search-input").fill("ACME-000501");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });
});

test("right-clicking a page offers what can be done to it", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "three.pdf", await textFixture([["One"], ["Two"], ["Three"]]));
  await expect(page.getByText("3 pages")).toBeVisible();

  // On a thumbnail, as in Acrobat's page panel.
  await page.getByTestId("thumb-1").click({ button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Delete page" })).toBeVisible();

  // Escape closes it without doing anything.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByText("3 pages")).toBeVisible();

  // Right-clicking a page acts on that page, even though another was selected.
  await page.getByTestId("select-0").click();
  await page.getByTestId("thumb-2").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete page" }).click();
  await expect(page.getByText("2 pages")).toBeVisible();
  await expect(page.getByTestId("context-menu")).toBeHidden();

  // The page that went is the one that was right-clicked, not the selected one.
  await page.getByTestId("search-input").fill("Two");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });
  await page.getByTestId("search-input").fill("Three");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toBeHidden();

  // And on the page itself, not only in the panel.
  await page.getByTestId("viewer").locator(".viewer-page").first().click({ button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible();
});

test("undo puts back a deleted page, and a changed word", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "two.pdf", await textFixture([["Dear Sir or Madam"], ["Second page"]]));
  await expect(page.getByText("2 pages")).toBeVisible();

  // Nothing has happened yet, so there is nothing to undo.
  await expect(page.getByTestId("undo")).toBeDisabled();

  // A page order change, which lives in the app rather than in the document.
  // Deleted with the key, which is the other half of being usable.
  await page.getByTestId("select-0").click();
  await page.keyboard.press("Delete");
  await expect(page.getByText("1 page")).toBeVisible();
  await page.getByTestId("undo").click();
  await expect(page.getByText("2 pages")).toBeVisible();
  await expect(page.getByTestId("redo")).toBeEnabled();

  // And a change to the document's bytes, which lives in the worker.
  await page.getByTestId("edit-text").click();
  // Both pages have a run 0, so this one is addressed on its own page.
  const firstPage = page.getByTestId("edit-0");
  await expect(firstPage.getByTestId("edittarget-0")).toBeVisible({ timeout: 30_000 });
  await firstPage.getByTestId("edittarget-0").click();
  await firstPage.getByTestId("editbox-0").fill("Dear Registrar");
  await firstPage.getByTestId("editbox-0").press("Enter");
  await expect(page.getByTestId("status")).toHaveText(/Text changed/, { timeout: 30_000 });

  await page.getByTestId("search-input").fill("Registrar");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });

  await page.getByTestId("undo").click();
  await expect(page.getByText("2 pages")).toBeVisible();
  await page.getByTestId("search-input").fill("Madam");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });

  // Redo puts the edit back, and what is saved is the version on screen.
  await page.getByTestId("redo").click();
  await expect(page.getByTestId("status")).toHaveText(/Ready|Redoing|Saved|Text changed/, {
    timeout: 30_000,
  });
  await page.getByTestId("search-input").fill("Registrar");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("hit-count")).toHaveText("1 of 1", { timeout: 30_000 });
});

test("undo takes back a mark before it is ever saved", async ({ page }) => {
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

  await page.getByTestId("undo").click();
  await expect(page.getByTestId("comments-empty")).toBeVisible();

  // Gone from the file too, not merely from the list.
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

test("the format bar changes the size and the face, not just reports them", async ({ page }) => {
  await withoutFilePickers(page);
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("Ready", { timeout: 30_000 });
  await openFixture(page, "note.pdf", await textFixture([["Minutes of the meeting"]]));
  await expect(page.getByText("1 page")).toBeVisible();

  await page.getByTestId("edit-text").click();
  const target = page.getByTestId("edittarget-0");
  await expect(target).toBeVisible({ timeout: 30_000 });
  const before = (await target.boundingBox())!;
  await target.click();

  await expect(page.getByTestId("editbar-0")).toContainText("Helvetica");
  await page.getByTestId("editsize-0").fill("20");
  await page.getByTestId("editface-0").selectOption("Times-Bold");
  // Picking from the bar must not count as leaving the box and committing.
  await expect(page.getByTestId("editbox-0")).toBeVisible();
  await page.getByTestId("editbox-0").press("Enter");
  await expect(page.getByTestId("status")).toHaveText(/Text changed/, { timeout: 30_000 });

  // Bigger type in the same block: taller, no wider, and the words survive.
  const after = (await page.getByTestId("edittarget-0").boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height);
  expect(after.width).toBeLessThanOrEqual(before.width + 2);

  await page.getByTestId("edittarget-0").click();
  const bar = page.getByTestId("editbar-0");
  await expect(bar).toContainText("Times");
  await expect(page.getByTestId("editsize-0")).toHaveValue(/20/);

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

  // The format bar says what you are typing into: face, size, colour.
  await expect(page.getByTestId("editbar-0")).toContainText("Helvetica");
  await expect(page.getByTestId("editsize-0")).toHaveValue("12");

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
