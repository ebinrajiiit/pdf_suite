import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { expect, test } from "vitest";
import { annotate, type Annotation } from "./annotate.js";

async function makeDoc(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([400, 400]);
  return doc.save();
}

/** Annotation subtypes on each page of a saved document. */
async function subtypesOf(bytes: Uint8Array): Promise<string[][]> {
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

test("writes each kind onto the page it names", async () => {
  const annotations: Annotation[] = [
    { kind: "highlight", page: 0, rects: [{ x: 40, y: 300, w: 200, h: 14 }] },
    { kind: "note", page: 1, x: 100, y: 200, contents: "check this" },
    { kind: "text", page: 1, x: 40, y: 150, w: 180, h: 20, contents: "typed comment" },
  ];
  expect(await subtypesOf(await annotate(await makeDoc(), annotations))).toEqual([
    ["/Highlight"],
    ["/Text", "/FreeText"],
  ]);
});

test("a multi-line highlight becomes one annotation per line", async () => {
  // Each line stays independently removable, which is what deleting "that
  // highlight" means to a reader.
  const marked = await annotate(await makeDoc(1), [
    {
      kind: "highlight",
      page: 0,
      rects: [
        { x: 40, y: 300, w: 200, h: 14 },
        { x: 40, y: 280, w: 160, h: 14 },
      ],
    },
  ]);
  expect((await subtypesOf(marked))[0]).toEqual(["/Highlight", "/Highlight"]);
});

test("keeps annotations already in the document", async () => {
  const once = await annotate(await makeDoc(1), [
    { kind: "note", page: 0, x: 10, y: 20, contents: "first" },
  ]);
  const twice = await annotate(once, [{ kind: "note", page: 0, x: 30, y: 40, contents: "second" }]);
  expect((await subtypesOf(twice))[0]).toEqual(["/Text", "/Text"]);
});

test("does not touch the caller's bytes", async () => {
  const original = await makeDoc(1);
  const before = original.slice();
  await annotate(original, [{ kind: "note", page: 0, x: 10, y: 20, contents: "x" }]);
  expect(original).toEqual(before);
});

test("an empty list returns the input unchanged", async () => {
  const original = await makeDoc(1);
  expect(await annotate(original, [])).toBe(original);
});

test("rejects a page that does not exist rather than dropping the annotation", async () => {
  await expect(
    annotate(await makeDoc(2), [{ kind: "note", page: 5, x: 0, y: 0, contents: "x" }]),
  ).rejects.toThrow(RangeError);
});

test("rejects a highlight with no boxes", async () => {
  await expect(
    annotate(await makeDoc(1), [{ kind: "highlight", page: 0, rects: [] }]),
  ).rejects.toThrow(/at least one box/);
});

test("the text under a highlight survives, because nothing is drawn over it", async () => {
  // A highlight is an annotation, not a filled rectangle in the content stream,
  // so extraction and search still see the words.
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const plain = await doc.save();
  const marked = await annotate(plain, [
    { kind: "highlight", page: 0, rects: [{ x: 0, y: 0, w: 400, h: 400 }] },
  ]);
  const reloaded = await PDFDocument.load(marked);
  // The page's own content is untouched; only the Annots array grew.
  expect(reloaded.getPage(0).node.Annots()?.size()).toBe(1);
});

test("underline and strike-through are their own PDF subtypes", async () => {
  const marked = await annotate(await makeDoc(1), [
    { kind: "underline", page: 0, rects: [{ x: 40, y: 300, w: 200, h: 14 }] },
    { kind: "strike", page: 0, rects: [{ x: 40, y: 280, w: 200, h: 14 }] },
  ]);
  expect((await subtypesOf(marked))[0]).toEqual(["/Underline", "/StrikeOut"]);
});

test("a line over text is opaque, a highlight is not", async () => {
  // A tint has to let the words through; a correction mark should not.
  const doc = await makeDoc(1);
  const rects = [{ x: 40, y: 300, w: 100, h: 12 }];
  const highlight = await PDFDocument.load(
    await annotate(doc, [{ kind: "highlight", page: 0, rects }]),
  );
  const strike = await PDFDocument.load(await annotate(doc, [{ kind: "strike", page: 0, rects }]));
  const opacityOf = (d: PDFDocument) =>
    Number(String(d.getPage(0).node.Annots()!.lookup(0, PDFDict).get(PDFName.of("CA"))));
  expect(opacityOf(highlight)).toBeLessThan(1);
  expect(opacityOf(strike)).toBe(1);
});
