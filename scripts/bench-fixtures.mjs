// Synthetic PDFs so the engine benchmark can run before the real corpus exists.
// They prove the harness and catch adapter bugs; they do NOT substitute for the
// 1,000-file corpus, and they contain no Indic text (pdf-lib's standard fonts are
// WinAnsi only), which is exactly what the spike most needs to measure.
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const A4 = [595.28, 841.89];

async function textDoc(pages, linesPerPage) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(A4);
    for (let i = 0; i < linesPerPage; i++) {
      page.drawText(`Page ${p + 1}, line ${i + 1}: the quick brown fox jumps over the lazy dog.`, {
        x: 48,
        y: 780 - i * 16,
        size: 11,
        font,
      });
    }
  }
  return doc.save();
}

async function vectorHeavyDoc() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  for (let i = 0; i < 4000; i++) {
    page.drawRectangle({
      x: (i * 37) % 560,
      y: (i * 53) % 800,
      width: 24,
      height: 18,
      color: rgb((i % 255) / 255, ((i * 7) % 255) / 255, ((i * 13) % 255) / 255),
      opacity: 0.6,
    });
  }
  return doc.save();
}

async function rotatedDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage(A4);
  page.setRotation(degrees(90));
  page.drawText("Rotated 90 degrees — pageSize must report the rotated box.", {
    x: 48,
    y: 700,
    size: 14,
    font,
  });
  return doc.save();
}

/** Writes the fixtures and returns how many. */
export async function generateFixtures(dir) {
  const files = {
    "text-1page.pdf": await textDoc(1, 40),
    "text-50pages.pdf": await textDoc(50, 40),
    "text-500pages.pdf": await textDoc(500, 20),
    "vector-heavy.pdf": await vectorHeavyDoc(),
    "rotated-90.pdf": await rotatedDoc(),
  };
  // Malformed input is normal (CLAUDE.md §4): a valid file cut off mid-body.
  const whole = files["text-50pages.pdf"];
  files["truncated.pdf"] = whole.slice(0, Math.floor(whole.length * 0.6));

  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(dir, name), bytes);
  }
  return Object.keys(files).length;
}
