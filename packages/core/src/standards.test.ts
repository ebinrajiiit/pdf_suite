import { PDFDocument, StandardFonts } from "pdf-lib";
import { expect, test } from "vitest";
import { attachFile } from "./attachments.js";
import { checkPdfA, checkPrint, isPortfolio, makePortfolio, setTrimBox } from "./standards.js";

/** A page using a standard font, which is never embedded. */
async function withStandardFont(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Minutes", { x: 50, y: 700, size: 12, font });
  return doc.save();
}

const idsOf = (issues: { id: string }[]) => issues.map((issue) => issue.id);

test("names what stands between an ordinary document and PDF/A", async () => {
  const issues = await checkPdfA(await withStandardFont());
  expect(idsOf(issues)).toContain("fonts");
  expect(idsOf(issues)).toContain("xmp");
  expect(idsOf(issues)).toContain("outputintent");
  // The font issue names the font, so it can be chased.
  expect(issues.find((issue) => issue.id === "fonts")?.detail).toContain("Helvetica");
});

test("a standard font counts as not embedded, because it is not in the file", async () => {
  const printing = await checkPrint(await withStandardFont());
  expect(idsOf(printing)).toContain("fonts");
});

test("an image is judged on the resolution it is printed at, not the pixels it has", async () => {
  const bytes = await withStandardFont();

  // 600 pixels across one inch is 600 DPI; across six inches it is 100.
  const fine = await checkPrint(bytes, {
    images: [{ page: 0, w: 72, h: 72, pixelWidth: 600, pixelHeight: 600 }],
  });
  expect(idsOf(fine)).not.toContain("resolution");

  const soft = await checkPrint(bytes, {
    images: [{ page: 0, w: 432, h: 432, pixelWidth: 600, pixelHeight: 600 }],
  });
  expect(idsOf(soft)).toContain("resolution");
  expect(soft.find((issue) => issue.id === "resolution")?.summary).toContain("300 DPI");
});

test("a trim box can be set, and then nothing complains about it", async () => {
  const bytes = await withStandardFont();
  expect(idsOf(await checkPrint(bytes))).toContain("trimbox");

  const trimmed = await setTrimBox(bytes, 9);
  expect(idsOf(await checkPrint(trimmed))).not.toContain("trimbox");

  const doc = await PDFDocument.load(trimmed);
  expect(doc.getPage(0).getTrimBox().width).toBeCloseTo(595 - 18, 0);
});

test("a bleed that would leave nothing of the page is refused", async () => {
  await expect(setTrimBox(await withStandardFont(), 400)).rejects.toThrow(/leave nothing/);
  await expect(setTrimBox(await withStandardFont(), -1)).rejects.toThrow(/cannot be negative/);
});

test("a portfolio is a document whose point is the files inside it", async () => {
  const plain = await withStandardFont();
  expect(await isPortfolio(plain)).toBe(false);
  // Without files there is nothing to be a portfolio of.
  await expect(makePortfolio(plain)).rejects.toThrow(/at least one file/);

  const withFile = await attachFile(plain, {
    name: "annexure.csv",
    bytes: new TextEncoder().encode("a,b\n1,2\n"),
  });
  expect(await isPortfolio(await makePortfolio(withFile))).toBe(true);
});
