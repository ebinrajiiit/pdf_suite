import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { expect, test } from "vitest";
import {
  attachFile,
  attachToPage,
  listAttachments,
  readAttachment,
  removeAttachment,
} from "./attachments.js";
import { findHidden, sanitise } from "./sanitise.js";

async function blank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return doc.save();
}

const annexure = new TextEncoder().encode("roll,marks\\n1,90\\n2,85\\n");

test("carries a file inside the document and gives it back unchanged", async () => {
  const withFile = await attachFile(await blank(), {
    name: "marks.csv",
    bytes: annexure,
    description: "Annexure A",
    type: "text/csv",
  });

  const listed = await listAttachments(withFile);
  expect(listed.map((file) => file.name)).toEqual(["marks.csv"]);
  expect(listed[0]?.description).toBe("Annexure A");
  expect(listed[0]?.size).toBe(annexure.length);

  expect(await readAttachment(withFile, "marks.csv")).toEqual(annexure);
});

test("carries several, and removes one without disturbing the rest", async () => {
  let bytes = await attachFile(await blank(), { name: "a.txt", bytes: new Uint8Array([65]) });
  bytes = await attachFile(bytes, { name: "b.txt", bytes: new Uint8Array([66]) });
  expect((await listAttachments(bytes)).map((file) => file.name)).toEqual(["a.txt", "b.txt"]);

  const fewer = await removeAttachment(bytes, "a.txt");
  expect((await listAttachments(fewer)).map((file) => file.name)).toEqual(["b.txt"]);
  expect(await readAttachment(fewer, "b.txt")).toEqual(new Uint8Array([66]));
});

test("asking for a file that is not there says so", async () => {
  const bytes = await blank();
  await expect(readAttachment(bytes, "missing.csv")).rejects.toThrow(/no file called/);
  await expect(removeAttachment(bytes, "missing.csv")).rejects.toThrow(/no file called/);
  expect(await listAttachments(bytes)).toEqual([]);
});

test("an attachment needs a name", async () => {
  await expect(attachFile(await blank(), { name: "  ", bytes: annexure })).rejects.toThrow(
    /needs a name/,
  );
});

test("sanitising removes them, which is the other half of carrying them", async () => {
  const withFile = await attachFile(await blank(), { name: "marks.csv", bytes: annexure });
  expect((await findHidden(withFile)).attachments).toBeGreaterThan(0);

  const cleaned = await sanitise(withFile, { attachments: true });
  expect(await listAttachments(cleaned.bytes)).toEqual([]);
});

test("attaches a file at a point on the page, pointing at the one copy of it", async () => {
  const bytes = await attachToPage(await blank(), {
    page: 0,
    x: 40,
    y: 150,
    name: "marks.csv",
    bytes: annexure,
    note: "Annexure A",
    author: "Registrar",
    type: "text/csv",
  });

  // The file is in the document and readable, as any attachment is.
  expect(await readAttachment(bytes, "marks.csv")).toEqual(annexure);

  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
  expect(annots.size()).toBe(1);
  const annot = annots.lookup(0, PDFDict);
  expect(annot.lookup(PDFName.of("Subtype"))?.toString()).toBe("/FileAttachment");

  // The rectangle is where it was asked for, and there is something to draw:
  // an attachment nobody can see on the page is the failure mode here.
  expect(
    annot
      .lookup(PDFName.of("Rect"), PDFArray)
      .asArray()
      .map((n) => Number(n.toString())),
  ).toEqual([40, 150, 60, 170]);
  const appearance = annot.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"));
  expect(appearance).toBeDefined();

  // /FS points at the file specification in the name tree rather than at a
  // second embedded copy of the same bytes.
  const fs = annot.get(PDFName.of("FS"));
  const names = doc.catalog
    .lookup(PDFName.of("Names"), PDFDict)
    .lookup(PDFName.of("EmbeddedFiles"), PDFDict)
    .lookup(PDFName.of("Names"), PDFArray);
  expect(fs?.toString()).toBe(names.get(1)?.toString());
});

test("will not attach to a page the document does not have", async () => {
  await expect(
    attachToPage(await blank(), { page: 3, x: 0, y: 0, name: "a.txt", bytes: annexure }),
  ).rejects.toThrow(/outside a 1-page/);
});
