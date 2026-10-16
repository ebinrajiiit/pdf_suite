import { PDFDocument } from "pdf-lib";
import { expect, test } from "vitest";
import { merge, reorder, rotate, split } from "./ops.js";

/** Pages are identified by their size, the one property pdf-lib can read back. */
async function makeDoc(sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [width, height] of sizes) doc.addPage([width, height]);
  return doc.save();
}

async function sizesOf(bytes: Uint8Array): Promise<[number, number][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
}

test("merge concatenates in argument order", async () => {
  const a = await makeDoc([[100, 200]]);
  const b = await makeDoc([
    [300, 400],
    [500, 600],
  ]);
  expect(await sizesOf(await merge([a, b]))).toEqual([
    [100, 200],
    [300, 400],
    [500, 600],
  ]);
});

test("merge leaves its inputs untouched", async () => {
  const a = await makeDoc([[100, 200]]);
  const before = a.slice();
  await merge([a, a]);
  expect(a).toEqual(before);
});

test("merge rejects an empty list", async () => {
  await expect(merge([])).rejects.toThrow(/at least one/);
});

test("reorder moves pages and can drop them", async () => {
  const doc = await makeDoc([
    [100, 100],
    [200, 200],
    [300, 300],
  ]);
  expect(await sizesOf(await reorder(doc, [2, 0, 1]))).toEqual([
    [300, 300],
    [100, 100],
    [200, 200],
  ]);
  // Omitting a page deletes it, which is how "delete pages" will work.
  expect(await sizesOf(await reorder(doc, [1]))).toEqual([[200, 200]]);
});

test("reorder rejects out-of-range and repeated pages", async () => {
  const doc = await makeDoc([[100, 100]]);
  await expect(reorder(doc, [1])).rejects.toThrow(RangeError);
  await expect(reorder(doc, [0, 0])).rejects.toThrow(/repeats/);
});

test("split cuts inclusive ranges", async () => {
  const doc = await makeDoc([
    [100, 100],
    [200, 200],
    [300, 300],
    [400, 400],
  ]);
  const parts = await split(doc, [
    [0, 1],
    [3, 3],
  ]);
  expect(await sizesOf(parts[0]!)).toEqual([
    [100, 100],
    [200, 200],
  ]);
  expect(await sizesOf(parts[1]!)).toEqual([[400, 400]]);
  await expect(split(doc, [[2, 9]])).rejects.toThrow(RangeError);
});

test("rotate adds to the existing rotation of the named pages only", async () => {
  const doc = await makeDoc([
    [100, 200],
    [100, 200],
  ]);
  const once = await rotate(doc, [0], 90);
  const twice = await rotate(once, [0], 270);

  const after = await PDFDocument.load(once);
  expect(after.getPage(0).getRotation().angle).toBe(90);
  expect(after.getPage(1).getRotation().angle).toBe(0);

  // 90 + 270 wraps back to 0 rather than becoming 360.
  const wrapped = await PDFDocument.load(twice);
  expect(wrapped.getPage(0).getRotation().angle).toBe(0);
});
