import { PDFDocument } from "pdf-lib";
import { expect, test } from "vitest";
import { imagesToPdf, isSupportedImage } from "./images.js";

/** A minimal valid PNG: 2x1 pixels, written by hand so the test needs no fixture. */
function tinyPng(): Uint8Array {
  const crc = (bytes: number[]) => {
    let c = ~0;
    for (const byte of bytes) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: number[]) => {
    const typed = [...type].map((c) => c.charCodeAt(0));
    const length = data.length;
    return [
      (length >>> 24) & 255,
      (length >>> 16) & 255,
      (length >>> 8) & 255,
      length & 255,
      ...typed,
      ...data,
      ...(() => {
        const v = crc([...typed, ...data]);
        return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      })(),
    ];
  };
  // 2x1, 8-bit RGB, no interlace; one uncompressed deflate block.
  const ihdr = [0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 0, 0];
  const raw = [0, 255, 0, 0, 0, 0, 255];
  const deflate = [0x78, 0x01, 0x01, raw.length, 0, 255 - raw.length, 255, ...raw];
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const adler = [(b >>> 8) & 255, b & 255, (a >>> 8) & 255, a & 255];
  return new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", [...deflate, ...adler]),
    ...chunk("IEND", []),
  ]);
}

const png = { bytes: tinyPng(), type: "image/png" };

test("recognises the formats it can embed", () => {
  expect(isSupportedImage("image/png")).toBe(true);
  expect(isSupportedImage("scan.JPG")).toBe(true);
  expect(isSupportedImage("image/jpeg")).toBe(true);
  expect(isSupportedImage("image/heic")).toBe(false);
  expect(isSupportedImage("notes.txt")).toBe(false);
});

test("gives each image its own page, sized to the image", async () => {
  const doc = await PDFDocument.load(await imagesToPdf([png, png]));
  expect(doc.getPageCount()).toBe(2);
  // 2x1 pixels at 0.75 points per pixel.
  const { width, height } = doc.getPage(0).getSize();
  expect([Math.round(width), Math.round(height)]).toEqual([2, 1]);
});

test("fits an image inside a fixed page without cropping it", async () => {
  const doc = await PDFDocument.load(
    await imagesToPdf([png], { page: { width: 595, height: 842, margin: 20 } }),
  );
  const { width, height } = doc.getPage(0).getSize();
  expect([width, height]).toEqual([595, 842]);
});

test("refuses a format it cannot embed instead of writing a blank page", async () => {
  await expect(imagesToPdf([{ bytes: png.bytes, type: "image/heic" }])).rejects.toThrow(
    /not a JPEG or PNG/,
  );
});

test("refuses an empty list", async () => {
  await expect(imagesToPdf([])).rejects.toThrow(/no images/);
});
