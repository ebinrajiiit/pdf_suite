import { PDFDocument, PDFString } from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * Writes real PDF annotation objects, not pixels burnt into the page, so they
 * stay selectable, editable and removable in any viewer — and so a highlight
 * never destroys the text underneath it.
 *
 * No appearance streams (`/AP`) are generated: PDFium and pdf.js both synthesise
 * appearances for these subtypes, which was verified by rendering with each
 * engine. A viewer that does neither will show nothing, which is the known
 * limitation to fix by generating `/AP` if it ever matters.
 */

/** A box in PDF points, origin at the page's bottom-left. */
export interface AnnotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Red, green, blue, each 0–1. */
export type AnnotColor = [number, number, number];

interface Common {
  /** Source page index. */
  page: number;
  color?: AnnotColor;
  /** Shown as the annotation's author in other viewers. */
  author?: string;
}

export type Annotation =
  | (Common & { kind: "highlight"; rects: AnnotRect[]; opacity?: number })
  | (Common & { kind: "note"; x: number; y: number; contents: string })
  | (Common & {
      kind: "text";
      x: number;
      y: number;
      w: number;
      h: number;
      contents: string;
      size?: number;
    });

const HIGHLIGHT_YELLOW: AnnotColor = [1, 0.85, 0.2];
const NOTE_YELLOW: AnnotColor = [1, 0.82, 0.25];
const TEXT_BLACK: AnnotColor = [0, 0, 0];
/** Bit 3 (value 4) is Print: without it many viewers omit the annotation on paper. */
const FLAG_PRINT = 4;

/** PDF date format, e.g. D:20261016120000Z. */
function pdfDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `D:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

/** Adds the annotations to the document and returns new bytes. */
export async function annotate(input: PdfBytes, annotations: Annotation[]): Promise<PdfBytes> {
  if (annotations.length === 0) return input;

  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const pageCount = doc.getPageCount();
  const stamp = pdfDate(new Date());

  for (const annotation of annotations) {
    if (!Number.isInteger(annotation.page) || annotation.page < 0 || annotation.page >= pageCount) {
      throw new RangeError(
        `annotation page ${annotation.page} outside a ${pageCount}-page document`,
      );
    }
    const page = doc.getPage(annotation.page);
    const context = doc.context;
    const author = annotation.author ?? "PDF Suite";

    const shared = {
      Type: "Annot",
      F: FLAG_PRINT,
      T: PDFString.of(author),
      M: PDFString.of(stamp),
      CreationDate: PDFString.of(stamp),
    };

    if (annotation.kind === "highlight") {
      if (annotation.rects.length === 0) throw new Error("a highlight needs at least one box");
      const colour = annotation.color ?? HIGHLIGHT_YELLOW;
      // One annotation per box keeps each line independently removable, which is
      // what a reader expects when they delete "that highlight".
      for (const rect of annotation.rects) {
        const left = rect.x;
        const right = rect.x + rect.w;
        const bottom = rect.y;
        const top = rect.y + rect.h;
        page.node.addAnnot(
          context.register(
            context.obj({
              ...shared,
              Subtype: "Highlight",
              Rect: [left, bottom, right, top],
              // QuadPoints order is upper-left, upper-right, lower-left, lower-right.
              QuadPoints: [left, top, right, top, left, bottom, right, bottom],
              C: colour,
              CA: annotation.opacity ?? 0.4,
            }),
          ),
        );
      }
      continue;
    }

    if (annotation.kind === "note") {
      const size = 24;
      page.node.addAnnot(
        context.register(
          context.obj({
            ...shared,
            Subtype: "Text",
            Rect: [annotation.x, annotation.y - size, annotation.x + size, annotation.y],
            Contents: PDFString.of(annotation.contents),
            Name: "Comment",
            C: annotation.color ?? NOTE_YELLOW,
            Open: false,
          }),
        ),
      );
      continue;
    }

    const size = annotation.size ?? 12;
    const [r, g, b] = annotation.color ?? TEXT_BLACK;
    page.node.addAnnot(
      context.register(
        context.obj({
          ...shared,
          Subtype: "FreeText",
          Rect: [
            annotation.x,
            annotation.y - annotation.h,
            annotation.x + annotation.w,
            annotation.y,
          ],
          Contents: PDFString.of(annotation.contents),
          // The default appearance string a viewer uses to lay the text out.
          DA: PDFString.of(`${r} ${g} ${b} rg /Helv ${size} Tf`),
          Q: 0,
        }),
      ),
    );
  }

  return doc.save();
}
