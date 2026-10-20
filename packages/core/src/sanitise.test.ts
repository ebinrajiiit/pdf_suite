import { PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { expect, test } from "vitest";
import { annotate } from "./annotate.js";
import { findHidden, sanitise } from "./sanitise.js";

/** A document carrying the things that travel without being visible. */
async function loaded(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  doc.setTitle("Admissions list FINAL");
  doc.setAuthor("Office Clerk");
  doc.setProducer("Some Converter 3.1");

  const context = doc.context;
  // A script that runs when the document opens.
  doc.catalog.set(
    PDFName.of("OpenAction"),
    context.obj({ S: "JavaScript", JS: PDFString.of("app.alert('hello')") }),
  );
  // A document-level script library.
  doc.catalog.set(
    PDFName.of("Names"),
    context.obj({
      JavaScript: context.obj({ Names: [PDFString.of("script"), context.obj({})] }),
      EmbeddedFiles: context.obj({ Names: [PDFString.of("data.xlsx"), context.obj({})] }),
    }),
  );
  return doc.save();
}

test("says what a document is carrying without changing it", async () => {
  const input = await loaded();
  const before = input.slice();
  const report = await findHidden(input);
  expect(input).toEqual(before);
  expect(report.metadata).toBe(true);
  expect(report.scripts).toBeGreaterThan(0);
  expect(report.attachments).toBeGreaterThan(0);
});

test("removes metadata, scripts and attachments, and says so", async () => {
  const { bytes, removed, wasClean } = await sanitise(await loaded());
  expect(wasClean).toBe(false);
  expect(removed.metadata).toBe(true);

  const doc = await PDFDocument.load(bytes);
  expect(doc.getTitle()).toBeUndefined();
  expect(doc.getAuthor()).toBeUndefined();
  expect(doc.catalog.get(PDFName.of("OpenAction"))).toBeUndefined();
  const names = doc.catalog.lookup(PDFName.of("Names"), PDFDict);
  expect(names.get(PDFName.of("JavaScript"))).toBeUndefined();
  expect(names.get(PDFName.of("EmbeddedFiles"))).toBeUndefined();
});

test("a document with nothing hidden is reported as already clean", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  // pdf-lib stamps its own producer and dates on create, so clear them first.
  const { bytes } = await sanitise(await doc.save());
  const second = await sanitise(bytes);
  expect(second.wasClean).toBe(true);
});

test("comments and links go only when asked for", async () => {
  const marked = await annotate(await loaded(), [
    { kind: "note", page: 0, x: 50, y: 350, contents: "check this" },
    { kind: "square", page: 0, x: 10, y: 10, w: 50, h: 50 },
  ]);

  const kept = await sanitise(marked, { comments: false });
  expect(kept.removed.comments).toBe(0);
  const keptDoc = await PDFDocument.load(kept.bytes);
  expect(keptDoc.getPage(0).node.Annots()?.size()).toBe(2);

  const stripped = await sanitise(marked, { comments: true });
  expect(stripped.removed.comments).toBe(2);
  const strippedDoc = await PDFDocument.load(stripped.bytes);
  expect(strippedDoc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
});

test("form fields are left in place when their scripts are removed", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  const field = form.createTextField("applicant.name");
  field.addToPage(page, { x: 20, y: 300, width: 200, height: 20 });
  // A keystroke script, where they actually live: on the widget the reader
  // types into, which is the field's kid.
  const widget = field.acroField.getWidgets()[0]!;
  widget.dict.set(
    PDFName.of("AA"),
    doc.context.obj({ K: doc.context.obj({ S: "JavaScript", JS: PDFString.of("x") }) }),
  );

  const { bytes, removed } = await sanitise(await doc.save(), { scripts: true });
  expect(removed.scripts).toBeGreaterThan(0);

  const after = await PDFDocument.load(bytes);
  expect(after.getForm().getTextField("applicant.name")).toBeDefined();
});
