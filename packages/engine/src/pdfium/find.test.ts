import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, expect, test } from "vitest";
import { createPdfiumEngine, type PdfiumEngine } from "./index.js";
import { boxesFor, expressionFor, literal } from "./find.js";

const wasmBinary = readFileSync(
  new URL("../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm", import.meta.url),
);

let engine: PdfiumEngine;
beforeAll(async () => {
  engine = await createPdfiumEngine({ wasmBinary: wasmBinary.buffer as ArrayBuffer });
});

async function pageOf(lines: string[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const page of lines) {
    const sheet = doc.addPage([595, 842]);
    page.forEach((line, i) => sheet.drawText(line, { x: 48, y: 760 - i * 20, size: 12, font }));
  }
  return doc.save();
}

test("words are matched as themselves, never as a pattern", () => {
  expect(literal("a.b*c")).toBe("a\\.b\\*c");
  const expression = expressionFor({ words: ["a.b*c"] })!;
  expect("a.b*c").toMatch(expression);
  expect("axbxxc").not.toMatch(new RegExp(expression.source, "u"));
});

test("an empty request matches nothing, rather than everything", () => {
  expect(expressionFor({})).toBeUndefined();
  expect(expressionFor({ words: ["  "] })).toBeUndefined();
});

test("a match that wraps a line becomes one box per line, not one tall one", () => {
  // Two characters on one line, two far below: a single box would black out
  // everything between them.
  const boxes = [
    { l: 10, r: 20, b: 700, t: 712 },
    { l: 20, r: 30, b: 700, t: 712 },
    { l: 10, r: 20, b: 600, t: 612 },
    { l: 20, r: 30, b: 600, t: 612 },
  ];
  const rects = boxesFor(boxes, 0, 4);
  expect(rects).toHaveLength(2);
  expect(rects[0]?.h).toBeLessThan(20);
  expect(rects[1]?.h).toBeLessThan(20);
});

test("finds Aadhaar numbers however they are spaced, and not the text around them", async () => {
  const bytes = await pageOf([
    ["Name: A Student", "Aadhaar: 1234 5678 9012", "Enrolled 2026"],
    ["Aadhaar 234567890123 on file"],
  ]);

  const found = await engine.findPattern(bytes, { patterns: ["aadhaar"] });
  expect(found.count).toBe(2);
  expect(found.areas.map((area) => area.page)).toEqual([0, 1]);

  // The box covers the number and not the whole line: the line it sits on is
  // over 200 points wide, the number is not.
  const rect = found.areas[0]?.rects[0];
  expect(rect).toBeDefined();
  expect(rect!.w).toBeLessThan(120);
  expect(rect!.h).toBeLessThan(20);
});

test("finds emails, PANs and phone numbers, and leaves ordinary numbers alone", async () => {
  const bytes = await pageOf([
    [
      "Write to a.student@iiitkottayam.ac.in",
      "PAN ABCDE1234F",
      "Call 9876543210",
      "Room 1234 at 10 am",
    ],
  ]);

  const found = await engine.findPattern(bytes, {
    patterns: ["email", "pan", "phone"],
  });
  expect(found.count).toBe(3);
  expect(found.samples.join(" ")).toContain("a.student@iiitkottayam.ac.in");
  expect(found.samples.join(" ")).toContain("ABCDE1234F");
});

test("searching a page that is not there is refused", async () => {
  const bytes = await pageOf([["One"]]);
  await expect(engine.findPattern(bytes, { words: ["One"], pages: [4] })).rejects.toThrow(
    /outside a 1-page document/,
  );
});
