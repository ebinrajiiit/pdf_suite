import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { expect, test } from "vitest";
import { hasOutline, setOutline } from "./outline.js";

// The structure is checked here; that PDFium can actually follow it is checked
// in the e2e test, which reads the bookmarks back through the real engine.

async function pages(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([300, 300]);
  return doc.save();
}

/** The outline root and a lookup helper for walking it. */
async function rootOf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const root = doc.catalog.lookup(PDFName.of("Outlines"), PDFDict);
  const at = (dict: PDFDict, key: string) => dict.lookup(PDFName.of(key));
  const title = (dict: PDFDict) => (at(dict, "Title") as PDFString).asString();
  return { doc, root, at, title };
}

test("writes a linked sibling chain with the titles given", async () => {
  const out = await setOutline(await pages(3), [
    { title: "One", page: 0 },
    { title: "Two", page: 1 },
    { title: "Three", page: 2 },
  ]);
  const { root, at, title } = await rootOf(out);

  const first = at(root, "First") as PDFDict;
  expect(title(first)).toBe("One");
  const second = at(first, "Next") as PDFDict;
  expect(title(second)).toBe("Two");
  const third = at(second, "Next") as PDFDict;
  expect(title(third)).toBe("Three");
  // The chain runs both ways, or a reader cannot walk backwards.
  expect(title(at(third, "Prev") as PDFDict)).toBe("Two");
  expect(title(at(root, "Last") as PDFDict)).toBe("Three");
  expect(third.get(PDFName.of("Next"))).toBeUndefined();
});

test("counts the whole open tree, and points children at their parent", async () => {
  const out = await setOutline(await pages(4), [
    { title: "Method", page: 1, children: [{ title: "Corpus", page: 2 }] },
    { title: "End", page: 3 },
  ]);
  const { root, at, title } = await rootOf(out);

  // Two top-level entries and one child: three open rows.
  expect(root.lookup(PDFName.of("Count"))?.toString()).toBe("3");
  const method = at(root, "First") as PDFDict;
  const child = at(method, "First") as PDFDict;
  expect(title(child)).toBe("Corpus");
  expect(title(at(child, "Parent") as PDFDict)).toBe("Method");
});

test("destinations name the page object, not a page number", async () => {
  const out = await setOutline(await pages(3), [{ title: "Third page", page: 2 }]);
  const { doc, root, at } = await rootOf(out);
  const dest = at(at(root, "First") as PDFDict, "Dest") as PDFArray;
  expect(dest.get(1)?.toString()).toBe("/XYZ");
  expect(dest.get(0)?.toString()).toBe(doc.getPage(2).ref.toString());
});

test("an empty list removes the outline", async () => {
  const added = await setOutline(await pages(2), [{ title: "Gone soon", page: 0 }]);
  expect(await hasOutline(added)).toBe(true);
  const removed = await setOutline(added, []);
  expect(await hasOutline(removed)).toBe(false);
});

test("a bookmark pointing past the end is refused, and the input is untouched", async () => {
  const input = await pages(2);
  const before = input.slice();
  await expect(setOutline(input, [{ title: "Nowhere", page: 7 }])).rejects.toThrow(
    /outside a 2-page document/,
  );
  expect(input).toEqual(before);
});
