import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { beforeAll, expect, test } from "vitest";
import { createPdfiumEngine, type PdfiumEngine } from "./index.js";

const wasmBinary = readFileSync(
  new URL("../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm", import.meta.url),
);

let engine: PdfiumEngine;
beforeAll(async () => {
  engine = await createPdfiumEngine({ wasmBinary: wasmBinary.buffer as ArrayBuffer });
});

/** A 2x2 red PNG, which is enough to be an image object. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFUlEQVR4nGP8z4AATAxQxhAXYAQAVAwCA1Ei" +
    "FmwAAAAASUVORK5CYII=",
  "base64",
);

async function withImages(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const png = await doc.embedPng(PNG);
  page.drawImage(png, { x: 50, y: 300, width: 80, height: 60 });
  page.drawImage(png, { x: 200, y: 100, width: 40, height: 40 });
  return doc.save();
}

test("lists the images on a page, with where each one sits", async () => {
  const images = await engine.images(await withImages(), 0);
  expect(images).toHaveLength(2);
  expect(images[0]?.x).toBeCloseTo(50, 1);
  expect(images[0]?.y).toBeCloseTo(300, 1);
  expect(images[0]?.w).toBeCloseTo(80, 1);
  expect(images[0]?.h).toBeCloseTo(60, 1);
  // The stored picture is tiny; the box it is drawn in is not.
  expect(images[0]?.pixelWidth).toBe(2);
});

test("moves and resizes an image without touching the picture", async () => {
  const bytes = await withImages();
  const [first] = await engine.images(bytes, 0);

  const result = await engine.editImages(bytes, [
    { page: 0, index: first!.index, action: "place", x: 120, y: 200, w: 160, h: 120 },
  ]);
  expect(result.applied).toBe(1);
  expect(result.rejected).toEqual([]);

  const after = await engine.images(result.bytes, 0);
  expect(after[0]?.x).toBeCloseTo(120, 1);
  expect(after[0]?.y).toBeCloseTo(200, 1);
  expect(after[0]?.w).toBeCloseTo(160, 1);
  expect(after[0]?.h).toBeCloseTo(120, 1);
  // Same picture, bigger box.
  expect(after[0]?.pixelWidth).toBe(2);
  // The other image is where it was.
  expect(after[1]?.x).toBeCloseTo(200, 1);
});

test("removes an image and leaves the rest alone", async () => {
  const bytes = await withImages();
  const images = await engine.images(bytes, 0);

  const result = await engine.editImages(bytes, [
    { page: 0, index: images[0]!.index, action: "remove" },
  ]);
  expect(result.applied).toBe(1);

  const after = await engine.images(result.bytes, 0);
  expect(after).toHaveLength(1);
  expect(after[0]?.x).toBeCloseTo(200, 1);
});

test("an index that is not an image is refused, not guessed at", async () => {
  const bytes = await withImages();
  const result = await engine.editImages(bytes, [{ page: 0, index: 99, action: "remove" }]);
  expect(result.applied).toBe(0);
  expect(result.rejected[0]?.reason).toMatch(/no longer there/);
  // And the document is unchanged.
  expect(await engine.images(result.bytes, 0)).toHaveLength(2);
});
