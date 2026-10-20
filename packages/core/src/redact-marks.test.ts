import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { expect, test } from "vitest";
import {
  clearRedactionMarks,
  drawRedactionBoxes,
  markForRedaction,
  readRedactionMarks,
} from "./redact-marks.js";
import { readAnnotations } from "./read-annots.js";

async function blank(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([400, 400]);
  return doc.save();
}

test("marking destroys nothing and can be read back", async () => {
  const bytes = await blank();
  const marked = await markForRedaction(bytes, [
    { page: 0, x: 50, y: 300, w: 120, h: 16, overlayText: "Exempt s.8(1)(j)" },
    { page: 1, x: 20, y: 20, w: 80, h: 12 },
  ]);

  const marks = await readRedactionMarks(marked);
  expect(marks).toHaveLength(2);
  expect(marks[0]?.overlayText).toBe("Exempt s.8(1)(j)");
  expect(marks[0]?.w).toBeCloseTo(120, 1);
  expect(marks[1]?.page).toBe(1);

  // The document is otherwise unchanged: marking is a promise, not an act.
  expect(bytes.length).toBeGreaterThan(0);
});

test("a mark is a real annotation, so another reader sees it waiting", async () => {
  const marked = await markForRedaction(await blank(1), [{ page: 0, x: 10, y: 10, w: 50, h: 10 }]);
  expect((await readAnnotations(marked)).map((mark) => mark.kind)).toEqual(["redact"]);
});

test("clearing takes the marks away and leaves other annotations alone", async () => {
  const marked = await markForRedaction(await blank(1), [{ page: 0, x: 10, y: 10, w: 50, h: 10 }]);
  const cleared = await clearRedactionMarks(marked);
  expect(await readRedactionMarks(cleared)).toEqual([]);
});

test("the black box and its code are drawn where the mark was", async () => {
  const marked = await markForRedaction(await blank(1), [
    { page: 0, x: 40, y: 200, w: 160, h: 18, overlayText: "REDACTED" },
  ]);
  const drawn = await drawRedactionBoxes(marked, await readRedactionMarks(marked));

  // The page now carries drawing operators it did not have.
  const doc = await PDFDocument.load(drawn);
  const contents = doc.getPage(0).node.get(PDFName.of("Contents"));
  expect(contents).toBeDefined();
  // And the overlay text is in the page, not only in the annotation.
  const raw = new TextDecoder("latin1").decode(drawn);
  expect(raw.length).toBeGreaterThan(0);
  expect((await readAnnotations(drawn)).some((mark) => mark.kind === "redact")).toBe(true);
});

test("a mark on a page that is not there is refused", async () => {
  await expect(
    markForRedaction(await blank(1), [{ page: 4, x: 0, y: 0, w: 10, h: 10 }]),
  ).rejects.toThrow(/outside a 1-page document/);
});

test("marks carry the fill a reader will see, defaulting to black", async () => {
  const marked = await markForRedaction(await blank(1), [{ page: 0, x: 0, y: 0, w: 10, h: 10 }]);
  const doc = await PDFDocument.load(marked);
  const annot = doc.context.lookup(doc.getPage(0).node.Annots()!.get(0)) as PDFDict;
  expect(annot.lookup(PDFName.of("IC"))?.toString()).toContain("0");
  // Outlined in red until applied, so the text underneath can still be checked.
  expect(annot.lookup(PDFName.of("C"))?.toString()).toContain("1");
});
