import { PDFDocument } from "pdf-lib";
import { expect, test } from "vitest";
import { annotate } from "./annotate.js";
import { deleteAnnotation, readAnnotations } from "./read-annots.js";
import { fillForm } from "./forms.js";
import { addField } from "./forms.js";

async function marked(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  doc.addPage([400, 400]);
  return annotate(await doc.save(), [
    {
      kind: "note",
      page: 0,
      x: 50,
      y: 300,
      contents: "Check the figures",
      author: "A Reviewer",
    },
    { kind: "square", page: 1, x: 20, y: 20, w: 80, h: 40, color: [1, 0, 0] },
  ]);
}

test("reads the marks a document already carries, with who said what", async () => {
  const marks = await readAnnotations(await marked());
  expect(marks).toHaveLength(2);

  const note = marks.find((mark) => mark.kind === "text");
  expect(note?.contents).toBe("Check the figures");
  expect(note?.author).toBe("A Reviewer");
  expect(note?.page).toBe(0);

  const box = marks.find((mark) => mark.kind === "square");
  expect(box?.page).toBe(1);
  expect(box?.colour).toEqual([1, 0, 0]);
  expect(box?.w).toBeCloseTo(80, 0);
});

test("a document with no marks reads as none, not as an error", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  expect(await readAnnotations(await doc.save())).toEqual([]);
});

test("form fields are not marks", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const withField = await addField(await doc.save(), {
    page: 0,
    name: "applicant.name",
    kind: "text",
    x: 20,
    y: 100,
    w: 150,
    h: 20,
  });
  // The field is a widget annotation on the page, and the Form panel's
  // business; it must not turn up in the list of comments.
  expect(await readAnnotations(withField)).toEqual([]);
  // And it still fills, so nothing was broken by ignoring it.
  expect(await fillForm(withField, { "applicant.name": "A" })).toBeDefined();
});

test("removes one mark and leaves the rest", async () => {
  const bytes = await marked();
  const before = await readAnnotations(bytes);
  const note = before.find((mark) => mark.page === 0)!;

  const after = await readAnnotations(await deleteAnnotation(bytes, note.page, note.index));
  expect(after).toHaveLength(1);
  expect(after[0]?.kind).toBe("square");
});

test("removing a mark that is not there is refused", async () => {
  const bytes = await marked();
  await expect(deleteAnnotation(bytes, 0, 9)).rejects.toThrow(/no mark 9 on page 1/);
  await expect(deleteAnnotation(bytes, 7, 0)).rejects.toThrow(/outside a 2-page document/);
});
