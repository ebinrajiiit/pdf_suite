import { PDFDocument } from "pdf-lib";
import { expect, test } from "vitest";
import { attachFile, listAttachments, readAttachment, removeAttachment } from "./attachments.js";
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
