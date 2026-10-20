import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * Redaction in two steps, as Acrobat does it: mark what should go, then apply.
 *
 * The marks are `/Redact` annotations written into the file, so the person who
 * marks the document need not be the person who applies it — a clerk marks the
 * Aadhaar numbers, the registrar checks the marks, and only then is anything
 * destroyed. Until applied, nothing is removed and the marks can be reviewed,
 * moved or deleted like any other annotation.
 *
 * Applying is the engine's job: taking content out of a page needs PDFium.
 * This half is the marking, the reading back, and the overlay text that goes
 * in the black box — "Exempt under s.8(1)(j)" is what a public authority has
 * to write there.
 */

export interface RedactionMark {
  /** Source page index. */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Words printed over the box, which is what a redaction code is. */
  overlayText?: string | undefined;
  /** Box colour. Black unless a reason is given to differ. */
  fill?: [number, number, number] | undefined;
}

/** Writes redaction marks into the document, destroying nothing. */
export async function markForRedaction(input: PdfBytes, marks: RedactionMark[]): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const count = doc.getPageCount();

  for (const mark of marks) {
    if (!Number.isInteger(mark.page) || mark.page < 0 || mark.page >= count) {
      throw new RangeError(`page ${mark.page} outside a ${count}-page document`);
    }
    const node = doc.getPage(mark.page).node;
    const rect = [mark.x, mark.y, mark.x + mark.w, mark.y + mark.h];
    const annot = doc.context.obj({
      Type: "Annot",
      Subtype: "Redact",
      Rect: rect,
      // The area to remove. One quad: the box itself.
      QuadPoints: [rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]],
      // What the box is filled with once applied.
      IC: mark.fill ?? [0, 0, 0],
      // Before applying, the mark is outlined rather than filled, so the text
      // under it can still be read and checked.
      C: [1, 0, 0],
      F: 4,
      ...(mark.overlayText
        ? {
            OverlayText: PDFString.of(mark.overlayText),
            Repeat: false,
            DA: PDFString.of("1 1 1 rg /Helv 9 Tf"),
            Q: 1,
          }
        : {}),
    });
    const existing = node.Annots()?.asArray() ?? [];
    node.set(PDFName.of("Annots"), doc.context.obj([...existing, doc.context.register(annot)]));
  }

  return doc.save();
}

/** The redaction marks waiting in the document. */
export async function readRedactionMarks(input: PdfBytes): Promise<RedactionMark[]> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const marks: RedactionMark[] = [];

  doc.getPages().forEach((page, pageIndex) => {
    page.node
      .Annots()
      ?.asArray()
      .forEach((ref) => {
        const annot = doc.context.lookup(ref);
        if (!(annot instanceof PDFDict)) return;
        if (String(annot.get(PDFName.of("Subtype"))) !== "/Redact") return;

        const rect = annot.lookup(PDFName.of("Rect"));
        const numbers =
          rect instanceof PDFArray ? rect.asArray().map((value) => Number(value.toString())) : [];
        const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = numbers;
        const overlay = annot.lookup(PDFName.of("OverlayText"));

        marks.push({
          page: pageIndex,
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
          ...(overlay instanceof PDFString || overlay instanceof PDFHexString
            ? { overlayText: overlay.decodeText() }
            : {}),
        });
      });
  });

  return marks;
}

/**
 * Removes the marks themselves, which is what applying them ends with: once
 * the content is gone, an annotation saying "remove this" is a note about
 * something that is no longer there.
 */
export async function clearRedactionMarks(input: PdfBytes): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const kept = annots.asArray().filter((ref) => {
      const annot = doc.context.lookup(ref);
      return !(annot instanceof PDFDict) || String(annot.get(PDFName.of("Subtype"))) !== "/Redact";
    });
    page.node.set(PDFName.of("Annots"), doc.context.obj(kept));
  }
  return doc.save();
}

/**
 * Draws the black boxes and their overlay text, for after the content has been
 * removed. The removal takes the words out; this is what the reader sees in
 * their place.
 */
export async function drawRedactionBoxes(
  input: PdfBytes,
  marks: RedactionMark[],
): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const { StandardFonts } = await import("pdf-lib");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const count = doc.getPageCount();

  for (const mark of marks) {
    if (mark.page < 0 || mark.page >= count) continue;
    const page = doc.getPage(mark.page);
    const [r, g, b] = mark.fill ?? [0, 0, 0];
    page.drawRectangle({
      x: mark.x,
      y: mark.y,
      width: mark.w,
      height: mark.h,
      color: { type: "RGB", red: r, green: g, blue: b } as never,
    });
    if (mark.overlayText) {
      // Sized to fit the box, because a redaction code that spills out of its
      // box over the text beside it is worse than no code at all.
      const size = Math.min(mark.h * 0.7, (mark.w * 1.7) / Math.max(mark.overlayText.length, 1));
      page.drawText(mark.overlayText, {
        x: mark.x + (mark.w - font.widthOfTextAtSize(mark.overlayText, size)) / 2,
        y: mark.y + (mark.h - size) / 2 + size * 0.2,
        size,
        font,
        color: { type: "RGB", red: 1, green: 1, blue: 1 } as never,
      });
    }
  }

  return doc.save();
}
