import { PDFDocument } from "pdf-lib";
import { expect, test } from "vitest";
import { readProperties, setProperties } from "./properties.js";

async function blank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.setTitle("Microsoft Word - final(2).docx");
  doc.setAuthor("Lab Laptop");
  return doc.save();
}

test("reads what a document says about itself", async () => {
  const properties = await readProperties(await blank());
  expect(properties.title).toBe("Microsoft Word - final(2).docx");
  expect(properties.author).toBe("Lab Laptop");
  expect(properties.subject).toBe("");
});

test("writes a better description, and can clear one", async () => {
  const out = await setProperties(await blank(), {
    title: "Minutes of the Academic Council",
    author: "",
    keywords: "council, minutes, 2026",
  });
  const properties = await readProperties(out);
  expect(properties.title).toBe("Minutes of the Academic Council");
  expect(properties.author).toBe("");
  expect(properties.keywords).toBe("council, minutes, 2026");
});

test("leaves the fields it was not given alone, and the input untouched", async () => {
  const input = await blank();
  const before = input.slice();
  const out = await setProperties(input, { subject: "Agenda item 4" });
  expect(input).toEqual(before);
  const properties = await readProperties(out);
  expect(properties.subject).toBe("Agenda item 4");
  expect(properties.title).toBe("Microsoft Word - final(2).docx");
});
