import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, expect, test } from "vitest";
import { createPdfiumEngine, type PdfiumEngine } from "./index.js";
import { groupIntoBlocks, wrap } from "./text-edit.js";

// PDFium's wasm runs under node, so the reflow path can be tested here rather
// than only through the browser: these tests build a PDF, edit its text and read
// the result back, all in-process.
const wasmBinary = readFileSync(
  new URL("../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm", import.meta.url),
);

let engine: PdfiumEngine;
beforeAll(async () => {
  engine = await createPdfiumEngine({ wasmBinary: wasmBinary.buffer as ArrayBuffer });
});

/** A page of lines in one font, laid out as a paragraph would be. */
async function fixture(
  lines: string[],
  opts: { font?: StandardFonts; size?: number } = {},
): Promise<Uint8Array> {
  const size = opts.size ?? 12;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(opts.font ?? StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  lines.forEach((text, i) => {
    page.drawText(text, { x: 50, y: 330 - i * size * 1.2, size, font });
  });
  return doc.save();
}

/** The page's own text, as extraction sees it. */
async function textOf(bytes: Uint8Array): Promise<string> {
  const handle = await engine.open(bytes.buffer as ArrayBuffer);
  try {
    const runs = await handle.extractText(0);
    return runs
      .map((run) => run.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    handle.close();
  }
}

test("wrap breaks on the measured width, never mid-word", () => {
  // One unit per character makes the expected breaks obvious.
  const measure = (s: string) => s.length;
  expect(wrap("the quick brown fox", 100, measure)).toEqual(["the quick brown fox"]);
  expect(wrap("the quick brown fox", 10, measure)).toEqual(["the quick", "brown fox"]);
  // A word longer than the line still goes on a line of its own rather than
  // being cut in half.
  expect(wrap("short electroencephalography", 10, measure)).toEqual([
    "short",
    "electroencephalography",
  ]);
  expect(wrap("   ", 10, measure)).toEqual([""]);
});

test("blocks group lines that line up, and split where they do not", () => {
  const line = (l: number, baseline: number, size = 10) => ({
    l,
    t: baseline + size,
    baseline,
    size,
  });
  // Three lines, same left edge, one line apart: one paragraph.
  expect(groupIntoBlocks([line(50, 300), line(50, 288), line(50, 276)])).toHaveLength(1);
  // A gap of four lines starts a new paragraph.
  expect(groupIntoBlocks([line(50, 300), line(50, 288), line(50, 240)])).toHaveLength(2);
  // So does a different left edge, which is what keeps two columns apart.
  expect(groupIntoBlocks([line(50, 300), line(250, 300), line(50, 288)])).toHaveLength(2);
  // And so does a different size, which keeps a heading out of its body text.
  expect(groupIntoBlocks([line(50, 300, 20), line(50, 288, 10)])).toHaveLength(2);
});

test("a paragraph is one editable block, a separated line is its own", async () => {
  const bytes = await fixture(["First line here", "second line here", "third line here"]);
  const blocks = await engine.editableText(bytes, 0);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.indices).toHaveLength(3);
  expect(blocks[0]?.text).toBe("First line here second line here third line here");
});

test("longer text re-wraps inside the paragraph's own width", async () => {
  const bytes = await fixture(["First line here", "second line here"]);
  const [block] = await engine.editableText(bytes, 0);
  const width = block!.w;

  const long =
    "This replacement is considerably longer than the two lines it replaces " +
    "and therefore has to wrap onto several lines of its own to fit.";
  const result = await engine.editText(bytes, [{ page: 0, indices: block!.indices, text: long }]);

  expect(result.applied).toBe(1);
  expect(result.rejected).toEqual([]);
  expect(result.addedLines).toBeGreaterThan(0);

  // Every line of the result stays inside the block it came from, which is what
  // reflow means: the text wrapped rather than running off the page.
  const after = await engine.editableText(result.bytes, 0);
  expect(after.length).toBeGreaterThanOrEqual(1);
  for (const line of after) expect(line.w).toBeLessThanOrEqual(width + 1);
  expect(after.flatMap((b) => b.indices).length).toBeGreaterThan(2);

  // And it is the document's own text, in order, not a note over it.
  expect(await textOf(result.bytes)).toBe(long);
});

test("shorter text gives back the lines it no longer needs", async () => {
  const bytes = await fixture(["First line here", "second line here", "third line here"]);
  const [block] = await engine.editableText(bytes, 0);

  const result = await engine.editText(bytes, [
    { page: 0, indices: block!.indices, text: "Short now" },
  ]);
  expect(result.applied).toBe(1);
  expect(result.addedLines).toBe(0);

  const after = await engine.editableText(result.bytes, 0);
  expect(after).toHaveLength(1);
  expect(after[0]?.indices).toHaveLength(1);
  expect(await textOf(result.bytes)).toBe("Short now");
});

test("a font with no glyph for the new text is substituted", async () => {
  // ZapfDingbats has no Latin letters at all, which is the extreme form of the
  // common case: an embedded subset missing a few glyphs.
  const bytes = await fixture(["\u2701\u2702"], { font: StandardFonts.ZapfDingbats });
  const [block] = await engine.editableText(bytes, 0);

  const result = await engine.editText(bytes, [
    { page: 0, indices: block!.indices, text: "Hello" },
  ]);

  expect(result.applied).toBe(1);
  expect(result.rejected).toEqual([]);
  expect(result.substituted).toHaveLength(1);
  expect(result.substituted[0]?.to).toBe("Helvetica");
  expect(result.substituted[0]?.characters).toContain("H");
  expect(await textOf(result.bytes)).toContain("Hello");
});

test("a character no standard font can draw is refused, not dropped", async () => {
  const bytes = await fixture(["Dear Sir"]);
  const [block] = await engine.editableText(bytes, 0);

  const result = await engine.editText(bytes, [
    { page: 0, indices: block!.indices, text: "Dear 😀" },
  ]);

  expect(result.applied).toBe(0);
  expect(result.substituted).toEqual([]);
  expect(result.rejected[0]?.reason).toMatch(/cannot show/);
  // Refused means unchanged, not half-written.
  expect(await textOf(result.bytes)).toContain("Dear Sir");
});

test("a block can be set in a different size, re-wrapping as it goes", async () => {
  const bytes = await fixture(["A line of text here", "and a second one below"]);
  const [block] = await engine.editableText(bytes, 0);

  const result = await engine.editText(bytes, [
    { page: 0, indices: block!.indices, text: block!.text, fontSize: 18 },
  ]);
  expect(result.applied).toBe(1);
  expect(result.rejected).toEqual([]);

  const after = await engine.editableText(result.bytes, 0);
  expect(after[0]?.fontSize).toBeCloseTo(18, 1);
  // Bigger text in the same width needs more lines, not a wider block.
  expect(after.flatMap((b) => b.indices).length).toBeGreaterThan(block!.indices.length);
  expect(await textOf(result.bytes)).toBe(block!.text);
});

test("a block can be set in another standard face", async () => {
  const bytes = await fixture(["Minutes of the meeting"]);
  const [block] = await engine.editableText(bytes, 0);
  expect(block?.fontName).toContain("Helvetica");

  const result = await engine.editText(bytes, [
    { page: 0, indices: block!.indices, text: block!.text, fontName: "Times-Bold" },
  ]);
  expect(result.applied).toBe(1);

  const after = await engine.editableText(result.bytes, 0);
  expect(after[0]?.fontName).toContain("Times");
  expect(await textOf(result.bytes)).toBe("Minutes of the meeting");
});

test("a face that is not a standard font is refused", async () => {
  const bytes = await fixture(["Minutes of the meeting"]);
  const [block] = await engine.editableText(bytes, 0);

  // The worker protocol is a trust boundary: the name is checked, not passed on.
  const result = await engine.editText(bytes, [
    { page: 0, indices: block!.indices, text: "Anything", fontName: "Comic Sans MS" },
  ]);
  expect(result.applied).toBe(0);
  expect(result.rejected[0]?.reason).toMatch(/not one of the PDF standard fonts/);
  expect(await textOf(result.bytes)).toBe("Minutes of the meeting");

  const silly = await engine.editText(bytes, [
    { page: 0, indices: block!.indices, text: "Anything", fontSize: 0 },
  ]);
  expect(silly.applied).toBe(0);
  expect(silly.rejected[0]?.reason).toMatch(/not a size/);
});
