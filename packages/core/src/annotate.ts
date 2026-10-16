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
 *
 * That constraint is also why there is no Line or Arrow kind. PDFium synthesises
 * appearances for Highlight, Underline, StrikeOut, Text, Square, Circle and Ink,
 * but not for Line — a Line annotation would be in the file and invisible in our
 * own viewer. Add it together with `/AP` generation.
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

/** The quad-based markup kinds, which differ only in subtype and colour. */
export type MarkupKind = "highlight" | "underline" | "strike";

/** Shared shape of the quad-based kinds. Each kind is its own union member so
 *  that `kind` stays a literal and narrowing works on it. */
interface Markup extends Common {
  rects: AnnotRect[];
  opacity?: number;
}

/** A freehand stroke, as a list of points in PDF points. */
export interface InkPoint {
  x: number;
  y: number;
}

export type Annotation =
  | (Markup & { kind: "highlight" })
  | (Markup & { kind: "underline" })
  | (Markup & { kind: "strike" })
  /** A box drawn on the page. PDF calls it a Square. */
  | (Common & { kind: "square"; x: number; y: number; w: number; h: number; width?: number })
  /** An ellipse inscribed in the given box. PDF calls it a Circle. */
  | (Common & { kind: "circle"; x: number; y: number; w: number; h: number; width?: number })
  /** Freehand strokes; each inner array is one continuous stroke. */
  | (Common & { kind: "ink"; strokes: InkPoint[][]; width?: number })
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
const INK_RED: AnnotColor = [0.85, 0.15, 0.15];
/** Default stroke width in points for shapes and ink. */
const STROKE = 2;
const LINE_RED: AnnotColor = [0.85, 0.15, 0.15];
const SUBTYPES: Record<MarkupKind, string> = {
  highlight: "Highlight",
  underline: "Underline",
  strike: "StrikeOut",
};
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

    if (
      annotation.kind === "highlight" ||
      annotation.kind === "underline" ||
      annotation.kind === "strike"
    ) {
      if (annotation.rects.length === 0) {
        throw new Error(`a ${annotation.kind} needs at least one box`);
      }
      // A line over text reads as a correction, so it defaults to red; a
      // highlight is a tint and defaults to yellow.
      const colour =
        annotation.color ?? (annotation.kind === "highlight" ? HIGHLIGHT_YELLOW : LINE_RED);
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
              Subtype: SUBTYPES[annotation.kind],
              Rect: [left, bottom, right, top],
              // QuadPoints order is upper-left, upper-right, lower-left, lower-right.
              QuadPoints: [left, top, right, top, left, bottom, right, bottom],
              C: colour,
              // A tint has to let the text through; a line does not.
              CA: annotation.opacity ?? (annotation.kind === "highlight" ? 0.4 : 1),
            }),
          ),
        );
      }
      continue;
    }

    if (annotation.kind === "square" || annotation.kind === "circle") {
      const width = annotation.width ?? STROKE;
      page.node.addAnnot(
        context.register(
          context.obj({
            ...shared,
            Subtype: annotation.kind === "square" ? "Square" : "Circle",
            Rect: [
              annotation.x,
              annotation.y,
              annotation.x + annotation.w,
              annotation.y + annotation.h,
            ],
            C: annotation.color ?? INK_RED,
            // Border style: the stroke width a viewer draws the outline with.
            BS: { W: width, S: "S" },
            CA: 1,
          }),
        ),
      );
      continue;
    }

    if (annotation.kind === "ink") {
      if (annotation.strokes.length === 0) throw new Error("ink needs at least one stroke");
      const points = annotation.strokes.flat();
      if (points.length === 0) throw new Error("ink needs at least one point");
      const width = annotation.width ?? STROKE;
      // The rectangle has to contain the strokes plus half the pen width, or
      // viewers clip the ends.
      const pad = width;
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      page.node.addAnnot(
        context.register(
          context.obj({
            ...shared,
            Subtype: "Ink",
            Rect: [
              Math.min(...xs) - pad,
              Math.min(...ys) - pad,
              Math.max(...xs) + pad,
              Math.max(...ys) + pad,
            ],
            // InkList is one array of alternating x y per stroke.
            InkList: annotation.strokes.map((stroke) => stroke.flatMap((p) => [p.x, p.y])),
            C: annotation.color ?? INK_RED,
            BS: { W: width, S: "S" },
            CA: 1,
          }),
        ),
      );
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
