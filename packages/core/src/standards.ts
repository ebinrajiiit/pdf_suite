import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * Checks against the standards a document has to meet to be archived or
 * printed — Acrobat's Preflight, in the two profiles an institution needs.
 *
 * Both are reports rather than conversions. Converting a document to PDF/A
 * means embedding every font it uses and an ICC profile to colour-manage it,
 * and a tool that says "converted" without doing both has produced a file that
 * fails validation somewhere else, later, in front of someone else. Saying
 * exactly what stands in the way is more useful and more honest.
 */

export interface StandardIssue {
  id: string;
  severity: "fail" | "warn";
  summary: string;
  detail: string;
}

export interface PrintCheckInput {
  /** Placed images, from the engine: pixels stored against points on the page. */
  images?: { page: number; w: number; h: number; pixelWidth: number; pixelHeight: number }[];
  /** The lowest effective resolution a printer should accept. */
  minimumDpi?: number;
}

/** What stands between this document and PDF/A. */
export async function checkPdfA(input: PdfBytes): Promise<StandardIssue[]> {
  const doc = await PDFDocument.load(input, { updateMetadata: false, ignoreEncryption: true });
  const issues: StandardIssue[] = [];

  if (doc.isEncrypted) {
    issues.push({
      id: "encrypted",
      severity: "fail",
      summary: "The document is encrypted",
      detail: "PDF/A does not allow encryption at all: an archive has to be readable forever.",
    });
  }

  const fonts = fontsIn(doc);
  const loose = fonts.filter((font) => !font.embedded).map((font) => font.name);
  if (loose.length > 0) {
    issues.push({
      id: "fonts",
      severity: "fail",
      summary: `${loose.length} font${loose.length === 1 ? " is" : "s are"} not embedded`,
      detail:
        `${loose.slice(0, 4).join(", ")}${loose.length > 4 ? "…" : ""}. ` +
        "A font that is not in the file is a font the reader has to find, and in " +
        "twenty years it will not.",
    });
  }

  if (doc.catalog.get(PDFName.of("Metadata")) === undefined) {
    issues.push({
      id: "xmp",
      severity: "fail",
      summary: "No XMP metadata",
      detail: "PDF/A identifies itself in an XMP packet, and this document has none.",
    });
  }

  if (doc.catalog.get(PDFName.of("OutputIntents")) === undefined) {
    issues.push({
      id: "outputintent",
      severity: "fail",
      summary: "No output intent",
      detail:
        "An archived document says which colour space its colours mean, with an " +
        "embedded ICC profile. Without one, the colours are a guess.",
    });
  }

  const names = doc.catalog.lookup(PDFName.of("Names"));
  if (names instanceof PDFDict && names.get(PDFName.of("JavaScript")) !== undefined) {
    issues.push({
      id: "javascript",
      severity: "fail",
      summary: "The document carries JavaScript",
      detail: "PDF/A forbids it. Remove hidden info takes it out.",
    });
  }

  return issues;
}

/** What a printer would complain about. */
export async function checkPrint(
  input: PdfBytes,
  options: PrintCheckInput = {},
): Promise<StandardIssue[]> {
  const doc = await PDFDocument.load(input, { updateMetadata: false, ignoreEncryption: true });
  const issues: StandardIssue[] = [];
  const minimum = options.minimumDpi ?? 300;

  const loose = fontsIn(doc).filter((font) => !font.embedded);
  if (loose.length > 0) {
    issues.push({
      id: "fonts",
      severity: "fail",
      summary: `${loose.length} font${loose.length === 1 ? " is" : "s are"} not embedded`,
      detail: "A press that does not have the font will substitute one, and the pages will reflow.",
    });
  }

  // Effective resolution: the stored pixels spread over the size it is printed
  // at. A 200-pixel logo across half a page is not a 200 DPI logo.
  const low = (options.images ?? []).filter((image) => {
    if (image.w <= 0 || image.h <= 0) return false;
    const dpi = Math.min((image.pixelWidth * 72) / image.w, (image.pixelHeight * 72) / image.h);
    return dpi < minimum;
  });
  if (low.length > 0) {
    issues.push({
      id: "resolution",
      severity: "warn",
      summary: `${low.length} image${low.length === 1 ? "" : "s"} below ${minimum} DPI`,
      detail:
        `On page${low.length === 1 ? "" : "s"} ` +
        `${[...new Set(low.map((image) => image.page + 1))].slice(0, 6).join(", ")}. ` +
        "They will look soft in print, however good they look on screen.",
    });
  }

  const withoutTrim = doc
    .getPages()
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => page.node.get(PDFName.of("TrimBox")) === undefined);
  if (withoutTrim.length === doc.getPageCount()) {
    issues.push({
      id: "trimbox",
      severity: "warn",
      summary: "No trim box",
      detail:
        "A press needs to know where the paper is cut. Without a trim box it uses the " +
        "page box, which is right only when there is no bleed.",
    });
  }

  return issues;
}

/** Sets the trim box on pages, inset from the page by the bleed given. */
export async function setTrimBox(
  input: PdfBytes,
  bleed: number,
  pages?: number[],
): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const count = doc.getPageCount();
  if (bleed < 0) throw new RangeError("a bleed cannot be negative");

  for (const index of pages ?? doc.getPageIndices()) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError(`page ${index} outside a ${count}-page document`);
    }
    const page = doc.getPage(index);
    const { width, height } = page.getSize();
    if (bleed * 2 >= width || bleed * 2 >= height) {
      throw new RangeError("that bleed would leave nothing of the page");
    }
    page.setTrimBox(bleed, bleed, width - bleed * 2, height - bleed * 2);
  }
  return doc.save();
}

/** Every font the document's pages name, and whether its data is in the file. */
function fontsIn(doc: PDFDocument): { name: string; embedded: boolean }[] {
  const found = new Map<string, boolean>();

  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    const fonts = resources?.lookup(PDFName.of("Font"));
    if (!(fonts instanceof PDFDict)) continue;

    for (const key of fonts.keys()) {
      const font = fonts.lookup(key);
      if (!(font instanceof PDFDict)) continue;
      const name = String(font.get(PDFName.of("BaseFont")) ?? key.asString()).replace(/^\//, "");

      // A composite font keeps its data one level down, in /DescendantFonts.
      const descendants = font.lookup(PDFName.of("DescendantFonts"));
      const described =
        descendants instanceof PDFArray && descendants.lookup(0) instanceof PDFDict
          ? (descendants.lookup(0) as PDFDict)
          : font;
      const descriptor = described.lookup(PDFName.of("FontDescriptor"));
      const embedded =
        descriptor instanceof PDFDict &&
        ["FontFile", "FontFile2", "FontFile3"].some(
          (key) => descriptor.get(PDFName.of(key)) !== undefined,
        );

      found.set(name, (found.get(name) ?? false) || embedded);
    }
  }

  return [...found].map(([name, embedded]) => ({ name, embedded }));
}

/**
 * Makes the document present as a portfolio: a container whose point is the
 * files inside it rather than its own pages.
 *
 * This is the whole of what a portfolio is that is worth having. Acrobat's own
 * portfolios also carry a Flash-era navigator, which no current reader runs.
 */
export async function makePortfolio(input: PdfBytes): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const names = doc.catalog.lookup(PDFName.of("Names"));
  const hasFiles = names instanceof PDFDict && names.get(PDFName.of("EmbeddedFiles")) !== undefined;
  if (!hasFiles) throw new Error("a portfolio needs at least one file attached to it");

  doc.catalog.set(
    PDFName.of("Collection"),
    doc.context.obj({ Type: "Collection", View: PDFName.of("D") }),
  );
  return doc.save();
}

/** True when the document says it is a portfolio. */
export async function isPortfolio(input: PdfBytes): Promise<boolean> {
  const doc = await PDFDocument.load(input, { updateMetadata: false, ignoreEncryption: true });
  return doc.catalog.get(PDFName.of("Collection")) !== undefined;
}
