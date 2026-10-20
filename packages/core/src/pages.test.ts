import {
  decodePDFRawStream,
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
} from "pdf-lib";
import { expect, test } from "vitest";
import { cropPages, setPageLabels, uncropPages, watermark } from "./pages.js";

async function sheets(count = 2, rotation = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Page ${i + 1}`, { x: 60, y: 760, size: 14, font });
    if (rotation) page.setRotation(degrees(rotation));
  }
  return doc.save();
}

test("cropping shows less of the page without removing anything", async () => {
  const out = await cropPages(await sheets(), { x: 50, y: 50, w: 400, h: 600 });
  const doc = await PDFDocument.load(out);
  const box = doc.getPage(0).getCropBox();
  expect(box.width).toBeCloseTo(400, 0);
  expect(box.height).toBeCloseTo(600, 0);
  // The media box is untouched: cropping hides, it does not delete.
  expect(doc.getPage(0).getMediaBox().width).toBeCloseTo(595, 0);
});

test("cropping a rotated page uses the reader's own frame", async () => {
  const out = await cropPages(await sheets(1, 90), { x: 0, y: 0, w: 400, h: 300 });
  const doc = await PDFDocument.load(out);
  const box = doc.getPage(0).getCropBox();
  // A quarter-turned page is 842 wide to the reader, so a 400x300 box in that
  // frame is 300x400 in the page's own.
  expect(box.width).toBeCloseTo(300, 0);
  expect(box.height).toBeCloseTo(400, 0);
});

test("cropping only the pages asked for, and refusing a box with nothing in it", async () => {
  const out = await cropPages(await sheets(3), { x: 10, y: 10, w: 200, h: 200 }, [1]);
  const doc = await PDFDocument.load(out);
  expect(doc.getPage(1).getCropBox().width).toBeCloseTo(200, 0);
  expect(doc.getPage(0).getCropBox().width).toBeCloseTo(595, 0);

  await expect(cropPages(await sheets(), { x: 0, y: 0, w: 0.2, h: 50 })).rejects.toThrow(
    /leave something of the page/,
  );
});

test("uncropping puts the whole page back", async () => {
  const cropped = await cropPages(await sheets(), { x: 50, y: 50, w: 200, h: 200 });
  const back = await uncropPages(cropped);
  const doc = await PDFDocument.load(back);
  expect(doc.getPage(0).getCropBox().width).toBeCloseTo(595, 0);
});

/** Each of a page's content streams, in the order a viewer draws them. */
async function streamsOf(bytes: Uint8Array, index = 0): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(index).node.get(PDFName.of("Contents"));
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    return stream instanceof PDFRawStream
      ? new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode())
      : "";
  });
}

/**
 * Which content stream draws a given string. pdf-lib writes text as a hex
 * operand and this file writes it literally, so both spellings count.
 */
function streamDrawing(streams: string[], text: string): number {
  const hex = [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return streams.findIndex(
    (stream) => stream.includes(`(${text}) Tj`) || stream.toLowerCase().includes(`<${hex}>`),
  );
}

test("a background watermark goes under the page's own content", async () => {
  const out = await watermark(await sheets(1), { text: "DRAFT" });
  // A page draws its streams in order, so underneath means earlier. pdf-lib
  // wraps the lot in its own q/Q streams, which is why this compares positions
  // rather than expecting to be first.
  const streams = await streamsOf(out);
  const mark = streamDrawing(streams, "DRAFT");
  const content = streamDrawing(streams, "Page 1");
  expect(mark).toBeGreaterThanOrEqual(0);
  expect(mark).toBeLessThan(content);

  // The names the stream uses have to be names the page actually has, or the
  // watermark references nothing and draws nothing. Checking that the stream
  // and the resources agree is the only assertion that catches it.
  const doc = await PDFDocument.load(out);
  const resources = doc.getPage(0).node.Resources();
  const fontUsed = /(\/[^\s/]+) [\d.]+ Tf/.exec(streams[mark] ?? "")?.[1];
  const stateUsed = /(\/[^\s/]+) gs/.exec(streams[mark] ?? "")?.[1];
  expect(fontUsed).toBeDefined();
  expect(stateUsed).toBeDefined();
  const fonts = resources?.lookup(PDFName.of("Font"), PDFDict);
  const states = resources?.lookup(PDFName.of("ExtGState"), PDFDict);
  expect(fonts?.keys().map((key) => key.asString())).toContain(fontUsed);
  expect(states?.keys().map((key) => key.asString())).toContain(stateUsed);
});

test("a front watermark draws over the content instead", async () => {
  const out = await watermark(await sheets(1), { text: "COPY", placement: "front" });
  const streams = await streamsOf(out);
  // Over the content means later.
  const mark = streamDrawing(streams, "COPY");
  const content = streamDrawing(streams, "Page 1");
  expect(mark).toBeGreaterThanOrEqual(0);
  expect(mark).toBeGreaterThan(content);
});

test("an empty watermark is refused", async () => {
  await expect(watermark(await sheets(), { text: "  " })).rejects.toThrow(/needs some text/);
});

test("page labels number the front matter apart from the body", async () => {
  const out = await setPageLabels(await sheets(6), [
    { from: 0, style: "r" },
    { from: 2, style: "D", start: 1 },
    { from: 4, style: "D", prefix: "A-", start: 1 },
  ]);
  const doc = await PDFDocument.load(out);
  const labels = doc.catalog.lookup(PDFName.of("PageLabels"), PDFDict);
  const nums = labels.lookup(PDFName.of("Nums"), PDFArray);
  expect(nums.size()).toBe(6);
  expect(nums.get(0)?.toString()).toBe("0");
  expect(nums.lookup(1, PDFDict).get(PDFName.of("S"))?.toString()).toBe("/r");
  expect(nums.lookup(5, PDFDict).get(PDFName.of("P"))?.toString()).toContain("A-");
});

test("labels have to start at the first page, and stay inside the document", async () => {
  await expect(setPageLabels(await sheets(2), [{ from: 1, style: "D" }])).rejects.toThrow(
    /start at the first page/,
  );
  await expect(
    setPageLabels(await sheets(2), [
      { from: 0, style: "D" },
      { from: 9, style: "r" },
    ]),
  ).rejects.toThrow(/outside a 2-page document/);
});

test("an empty list removes the labels", async () => {
  const labelled = await setPageLabels(await sheets(2), [{ from: 0, style: "r" }]);
  const cleared = await setPageLabels(labelled, []);
  const doc = await PDFDocument.load(cleared);
  expect(doc.catalog.get(PDFName.of("PageLabels"))).toBeUndefined();
});
