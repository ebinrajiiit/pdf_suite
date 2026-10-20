import { PDFDocument, PDFString, StandardFonts, type PDFRef } from "pdf-lib";
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
 * The exceptions are the kinds no viewer synthesises: Line, and Stamp. Those
 * carry an appearance stream of their own, drawn here, which is why they can
 * exist at all — a Line without `/AP` is in the file and invisible in PDFium,
 * which is our own renderer.
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
  /**
   * A measurement this mark reports — "3.40 m", "8.25 m² · 12.0 m round".
   * Written as the mark's contents and drawn beside it, which is what makes a
   * line a dimension rather than a line.
   */
  measurement?: string | undefined;
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

/** Where a line carries an arrowhead. */
export type ArrowEnds = "none" | "end" | "both";

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
  /** A straight line, with or without arrowheads. Carries its own appearance. */
  | (Common & {
      kind: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width?: number;
      arrow?: ArrowEnds;
    })
  /**
   * A closed shape through the points given — PDF's Polygon — or an open one,
   * PolyLine. Cloudy is the same polygon with a cloud border, which is how a
   * reviewer rings a whole region of a drawing.
   */
  | (Common & {
      kind: "polygon";
      points: InkPoint[];
      width?: number;
      /** Closed with a cloud border, as Acrobat's Cloud tool draws. */
      cloud?: boolean;
    })
  | (Common & { kind: "polyline"; points: InkPoint[]; width?: number })
  /**
   * A box of text with a line pointing at what it is about — Acrobat's Callout.
   * The box is where the words go; the knee and the tip are where the line
   * goes.
   */
  | (Common & {
      kind: "callout";
      x: number;
      y: number;
      w: number;
      h: number;
      contents: string;
      /** The point being indicated, in PDF points. */
      tipX: number;
      tipY: number;
      size?: number;
      width?: number;
    })
  /**
   * A caret: the mark that says "something belongs here". PDF's Caret carries
   * no text of its own, so what should be inserted goes in its contents, as
   * Acrobat does.
   */
  | (Common & { kind: "caret"; x: number; y: number; contents: string })
  /** A rubber stamp: a labelled box, as in Approved or Draft. */
  | (Common & { kind: "stamp"; x: number; y: number; w: number; h: number; label: string })
  /**
   * A drawn signature, placed as one object rather than as loose ink so it can
   * be moved and resized. Strokes are in 0-1 of the box, so the same signature
   * fits any size.
   */
  | (Common & {
      kind: "signature";
      x: number;
      y: number;
      w: number;
      h: number;
      strokes: InkPoint[][];
    })
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
const STAMP_RED: AnnotColor = [0.78, 0.1, 0.1];
/** Signatures are blue ink on paper forms, so that they are obviously original. */
const SIGNATURE_INK: AnnotColor = [0.1, 0.18, 0.55];
const TEXT_BLACK: AnnotColor = [0, 0, 0];
/** Bit 3 (value 4) is Print: without it many viewers omit the annotation on paper. */
const FLAG_PRINT = 4;

/**
 * An appearance stream: the drawing a viewer shows for an annotation.
 *
 * Highlight, Square, Circle, Ink and the rest are synthesised by PDFium and
 * pdf.js from their geometry, so they need none. Line and Stamp are not, and
 * without this they would be in the file and invisible.
 *
 * The form's `/BBox` is given in page coordinates and matches the annotation's
 * `/Rect`, which makes the form-to-rect mapping the identity — so the operators
 * below are written in the page's own coordinates and need no second frame of
 * reference.
 */
function appearance(
  doc: PDFDocument,
  rect: [number, number, number, number],
  operators: string,
  fonts?: Record<string, PDFRef>,
): PDFRef {
  return doc.context.register(
    doc.context.flateStream(operators, {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: rect,
      Resources: fonts ? { Font: fonts } : {},
    }),
  );
}

/** PDF numbers: short, and never in exponent notation, which PDF has no syntax for. */
function n(value: number): string {
  return (Math.round(value * 1000) / 1000).toString();
}

/** The operators for a line, with arrowheads where asked for. */
function lineOperators(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  colour: AnnotColor,
  arrow: ArrowEnds,
): string {
  const [r, g, b] = colour;
  const stroke = `${n(r)} ${n(g)} ${n(b)} RG`;
  const fill = `${n(r)} ${n(g)} ${n(b)} rg`;
  const head = (tipX: number, tipY: number, fromX: number, fromY: number): string => {
    const length = Math.hypot(tipX - fromX, tipY - fromY) || 1;
    // A head that grows with the pen, as every drawing program does it.
    const size = Math.max(6, width * 3.5);
    const ux = (tipX - fromX) / length;
    const uy = (tipY - fromY) / length;
    // Back along the line, then out to each side.
    const baseX = tipX - ux * size;
    const baseY = tipY - uy * size;
    const spread = size * 0.4;
    return (
      `${n(tipX)} ${n(tipY)} m ` +
      `${n(baseX - uy * spread)} ${n(baseY + ux * spread)} l ` +
      `${n(baseX + uy * spread)} ${n(baseY - ux * spread)} l f\n`
    );
  };

  let ops = `q\n${stroke}\n${fill}\n${n(width)} w 1 J 1 j\n`;
  ops += `${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S\n`;
  if (arrow === "end" || arrow === "both") ops += head(x2, y2, x1, y1);
  if (arrow === "both") ops += head(x1, y1, x2, y2);
  return `${ops}Q\n`;
}

/** How far a cloud's bumps stand off the line they are drawn on. */
const CLOUD_RADIUS = 7;

/** Escapes a string operand so a bracket in it does not end the string. */
function escape(text: string): string {
  return text.replace(/([()\\])/g, "\\$1");
}

/** A path through the points, stroked, closed or not. */
function polyOperators(
  points: InkPoint[],
  width: number,
  colour: AnnotColor,
  closed: boolean,
): string {
  const [r, g, b] = colour;
  const path = points
    .map((point, index) => `${n(point.x)} ${n(point.y)} ${index === 0 ? "m" : "l"}`)
    .join(" ");
  return `q\n${n(r)} ${n(g)} ${n(b)} RG ${n(width)} w 1 J 1 j\n${path}${closed ? " h" : ""} S\nQ\n`;
}

/**
 * The same outline drawn as a cloud: a row of arcs along each edge, bulging
 * outwards. Each arc is two Bézier curves, which is close enough to a
 * semicircle that nobody has ever noticed the difference.
 */
function cloudOperators(points: InkPoint[], width: number, colour: AnnotColor): string {
  const [r, g, b] = colour;
  let ops = `q\n${n(r)} ${n(g)} ${n(b)} RG ${n(width)} w 1 J 1 j\n`;
  let started = false;

  for (let i = 0; i < points.length; i++) {
    const from = points[i]!;
    const to = points[(i + 1) % points.length]!;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length === 0) continue;
    // Whole bumps only, so the last one lands on the corner.
    const bumps = Math.max(1, Math.round(length / (CLOUD_RADIUS * 2)));
    const step = length / bumps;
    const ux = (to.x - from.x) / length;
    const uy = (to.y - from.y) / length;
    // Outward is to the left of travel for a clockwise outline, which is the
    // direction a reader draws one in.
    const nx = -uy;
    const ny = ux;

    for (let bump = 0; bump < bumps; bump++) {
      const startX = from.x + ux * step * bump;
      const startY = from.y + uy * step * bump;
      const endX = from.x + ux * step * (bump + 1);
      const endY = from.y + uy * step * (bump + 1);
      const bulge = step * 0.55;
      if (!started) {
        ops += `${n(startX)} ${n(startY)} m\n`;
        started = true;
      }
      ops +=
        `${n(startX + nx * bulge)} ${n(startY + ny * bulge)} ` +
        `${n(endX + nx * bulge)} ${n(endY + ny * bulge)} ` +
        `${n(endX)} ${n(endY)} c\n`;
    }
  }
  return `${ops}S\nQ\n`;
}

/**
 * The measurement written beside the mark that measured it, on a pale plate so
 * it stays readable over a drawing.
 */
async function measurementLabel(
  doc: PDFDocument,
  x: number,
  y: number,
  text: string,
  colour: AnnotColor,
): Promise<string> {
  const font = await stampFont(doc);
  const size = 9;
  const width = font.font.widthOfTextAtSize(text, size);
  const [r, g, b] = colour;
  return (
    `q\n1 1 1 rg\n${n(x - width / 2 - 2)} ${n(y - 2)} ${n(width + 4)} ${n(size + 3)} re f\n` +
    `${n(r)} ${n(g)} ${n(b)} rg BT /F1 ${n(size)} Tf ` +
    `1 0 0 1 ${n(x - width / 2)} ${n(y)} Tm (${escape(text)}) Tj ET\nQ\n`
  );
}

/** Greedy wrapping for the text inside a callout box. */
function wrapToWidth(
  text: string,
  width: number,
  size: number,
  font: { widthOfTextAtSize(text: string, size: number): number },
): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line !== "" && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** PDF date format, e.g. D:20261016120000Z. */
function pdfDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `D:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

/** Helvetica-Bold, embedded once however many stamps a document gets. */
async function stampFont(doc: PDFDocument) {
  const cached = fonts.get(doc);
  if (cached) return cached;
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const entry = { font, ref: font.ref };
  fonts.set(doc, entry);
  return entry;
}
const fonts = new WeakMap<
  PDFDocument,
  { font: Awaited<ReturnType<PDFDocument["embedFont"]>>; ref: PDFRef }
>();

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

    if (annotation.kind === "polygon" || annotation.kind === "polyline") {
      const points = annotation.points;
      if (points.length < 2) throw new Error(`a ${annotation.kind} needs at least two points`);
      const width = annotation.width ?? STROKE;
      const colour = annotation.color ?? INK_RED;
      const closed = annotation.kind === "polygon";
      const cloudy = closed && annotation.cloud === true;
      // A cloud's bumps stand outside the line they are drawn on.
      const pad = width * 2 + (cloudy ? CLOUD_RADIUS : 0);
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const rect: [number, number, number, number] = [
        Math.min(...xs) - pad,
        Math.min(...ys) - pad,
        Math.max(...xs) + pad,
        Math.max(...ys) + pad,
      ];

      page.node.addAnnot(
        context.register(
          context.obj({
            ...shared,
            Subtype: closed ? "Polygon" : "PolyLine",
            Rect: rect,
            Vertices: points.flatMap((point) => [point.x, point.y]),
            C: colour,
            BS: { W: width, S: "S" },
            ...(annotation.measurement
              ? { Contents: PDFString.of(annotation.measurement), IT: "PolygonDimension" }
              : {}),
            // The border effect is what makes a polygon a cloud: C for cloudy,
            // with an intensity. Readers that ignore it still see the shape,
            // because the appearance below draws the bumps itself.
            ...(cloudy ? { BE: { S: "C", I: 1 } } : {}),
            CA: 1,
            AP: {
              N: appearance(
                doc,
                rect,
                (cloudy
                  ? cloudOperators(points, width, colour)
                  : polyOperators(points, width, colour, closed)) +
                  (annotation.measurement
                    ? await measurementLabel(
                        doc,
                        xs.reduce((sum, value) => sum + value, 0) / xs.length,
                        ys.reduce((sum, value) => sum + value, 0) / ys.length,
                        annotation.measurement,
                        colour,
                      )
                    : ""),
                annotation.measurement ? { F1: (await stampFont(doc)).ref } : undefined,
              ),
            },
          }),
        ),
      );
      continue;
    }

    if (annotation.kind === "callout") {
      const width = annotation.width ?? STROKE;
      const colour = annotation.color ?? INK_RED;
      const size = annotation.size ?? 11;
      const font = await stampFont(doc);
      // The rectangle has to hold the box and the line to what it points at.
      const rect: [number, number, number, number] = [
        Math.min(annotation.x, annotation.tipX) - width * 2,
        Math.min(annotation.y, annotation.tipY) - width * 2,
        Math.max(annotation.x + annotation.w, annotation.tipX) + width * 2,
        Math.max(annotation.y + annotation.h, annotation.tipY) + width * 2,
      ];
      // The line leaves the box from the side the tip is on, with a knee
      // partway, which is how Acrobat draws one.
      const fromX = annotation.tipX < annotation.x ? annotation.x : annotation.x + annotation.w;
      const fromY = annotation.y + annotation.h / 2;
      const kneeX = (fromX + annotation.tipX) / 2;
      const [r, g, b] = colour;

      const lines = wrapToWidth(annotation.contents, annotation.w - 6, size, font.font);
      const text = lines
        .map(
          (line, index) =>
            `1 0 0 1 ${n(annotation.x + 3)} ` +
            `${n(annotation.y + annotation.h - size - index * size * 1.2 - 2)} Tm ` +
            `(${escape(line)}) Tj`,
        )
        .join("\n");

      page.node.addAnnot(
        context.register(
          context.obj({
            ...shared,
            Subtype: "FreeText",
            Rect: rect,
            Contents: PDFString.of(annotation.contents),
            // Callout line: tip, knee, and where it meets the box.
            CL: [annotation.tipX, annotation.tipY, kneeX, annotation.tipY, fromX, fromY],
            IT: "FreeTextCallout",
            DA: PDFString.of(`${n(r)} ${n(g)} ${n(b)} rg /Helv ${n(size)} Tf`),
            C: [1, 1, 1],
            CA: 1,
            AP: {
              N: appearance(
                doc,
                rect,
                `q\n${n(r)} ${n(g)} ${n(b)} RG ${n(width)} w\n` +
                  `${n(annotation.x)} ${n(annotation.y)} ${n(annotation.w)} ${n(annotation.h)} re S\n` +
                  `${n(annotation.tipX)} ${n(annotation.tipY)} m ` +
                  `${n(kneeX)} ${n(annotation.tipY)} l ${n(fromX)} ${n(fromY)} l S\n` +
                  `${n(r)} ${n(g)} ${n(b)} rg BT /F1 ${n(size)} Tf\n${text}\nET\nQ\n`,
                { F1: font.ref },
              ),
            },
          }),
        ),
      );
      continue;
    }

    if (annotation.kind === "caret") {
      const colour = annotation.color ?? INK_RED;
      // A caret is drawn small, at the point where something is missing.
      const size = 10;
      const rect: [number, number, number, number] = [
        annotation.x - size / 2,
        annotation.y,
        annotation.x + size / 2,
        annotation.y + size,
      ];
      const [r, g, b] = colour;
      page.node.addAnnot(
        context.register(
          context.obj({
            ...shared,
            Subtype: "Caret",
            Rect: rect,
            Contents: PDFString.of(annotation.contents),
            C: colour,
            CA: 1,
            AP: {
              N: appearance(
                doc,
                rect,
                `q\n${n(r)} ${n(g)} ${n(b)} rg\n` +
                  `${n(rect[0])} ${n(rect[1])} m ` +
                  `${n(annotation.x)} ${n(rect[3])} l ` +
                  `${n(rect[2])} ${n(rect[1])} l f\nQ\n`,
              ),
            },
          }),
        ),
      );
      continue;
    }

    if (annotation.kind === "line") {
      const width = annotation.width ?? STROKE;
      const colour = annotation.color ?? INK_RED;
      const arrow = annotation.arrow ?? "none";
      // The box has to hold the pen and the arrowhead, or viewers clip them.
      const pad = Math.max(width * 2, arrow === "none" ? width : Math.max(6, width * 3.5));
      const rect: [number, number, number, number] = [
        Math.min(annotation.x1, annotation.x2) - pad,
        Math.min(annotation.y1, annotation.y2) - pad,
        Math.max(annotation.x1, annotation.x2) + pad,
        Math.max(annotation.y1, annotation.y2) + pad,
      ];
      const label = annotation.measurement
        ? await measurementLabel(
            doc,
            (annotation.x1 + annotation.x2) / 2,
            (annotation.y1 + annotation.y2) / 2,
            annotation.measurement,
            colour,
          )
        : "";

      page.node.addAnnot(
        context.register(
          context.obj({
            ...shared,
            Subtype: "Line",
            Rect: rect,
            L: [annotation.x1, annotation.y1, annotation.x2, annotation.y2],
            // The line-ending names are what another editor reads to know this
            // is an arrow; the appearance below is what every viewer draws.
            LE: ["None", arrow === "none" ? "None" : "OpenArrow"],
            C: colour,
            IC: colour,
            BS: { W: width, S: "S" },
            CA: 1,
            ...(annotation.measurement
              ? {
                  Contents: PDFString.of(annotation.measurement),
                  // What Acrobat marks a dimension line with, so its own
                  // measuring tool recognises one of ours.
                  IT: "LineDimension",
                  Cap: true,
                }
              : {}),
            AP: {
              N: appearance(
                doc,
                rect,
                lineOperators(
                  annotation.x1,
                  annotation.y1,
                  annotation.x2,
                  annotation.y2,
                  width,
                  colour,
                  arrow,
                ) + label,
                annotation.measurement ? { F1: (await stampFont(doc)).ref } : undefined,
              ),
            },
          }),
        ),
      );
      continue;
    }

    if (annotation.kind === "stamp") {
      const colour = annotation.color ?? STAMP_RED;
      const rect: [number, number, number, number] = [
        annotation.x,
        annotation.y,
        annotation.x + annotation.w,
        annotation.y + annotation.h,
      ];
      const label = annotation.label.toUpperCase();
      const font = await stampFont(doc);
      // Big enough to read, small enough to fit the box both ways.
      const size = Math.min(annotation.h * 0.55, (annotation.w * 1.6) / Math.max(label.length, 1));
      const textWidth = font.font.widthOfTextAtSize(label, size);
      const [r, g, b] = colour;
      const inset = Math.max(1.5, annotation.h * 0.08);
      const ops =
        `q\n${n(r)} ${n(g)} ${n(b)} RG ${n(r)} ${n(g)} ${n(b)} rg\n` +
        `${n(inset)} w\n` +
        `${n(rect[0] + inset)} ${n(rect[1] + inset)} ` +
        `${n(annotation.w - inset * 2)} ${n(annotation.h - inset * 2)} re S\n` +
        `BT /F1 ${n(size)} Tf ` +
        `1 0 0 1 ${n(rect[0] + (annotation.w - textWidth) / 2)} ` +
        `${n(rect[1] + (annotation.h - size * 0.7) / 2)} Tm\n` +
        `(${label.replace(/([()\\])/g, "\\$1")}) Tj ET\nQ\n`;

      page.node.addAnnot(
        context.register(
          context.obj({
            ...shared,
            Subtype: "Stamp",
            Rect: rect,
            Name: "Draft",
            Contents: PDFString.of(annotation.label),
            C: colour,
            CA: 1,
            AP: { N: appearance(doc, rect, ops, { F1: font.ref }) },
          }),
        ),
      );
      continue;
    }

    if (annotation.kind === "signature") {
      if (annotation.strokes.length === 0) throw new Error("a signature needs at least one stroke");
      const colour = annotation.color ?? SIGNATURE_INK;
      const rect: [number, number, number, number] = [
        annotation.x,
        annotation.y,
        annotation.x + annotation.w,
        annotation.y + annotation.h,
      ];
      const width = Math.max(1, Math.min(annotation.w, annotation.h) * 0.02);
      const [r, g, b] = colour;
      // Strokes arrive in 0-1 of the box, so one drawn signature fits any size.
      const paths = annotation.strokes
        .filter((stroke) => stroke.length > 0)
        .map((stroke) =>
          stroke
            .map((point, index) => {
              const px = rect[0] + point.x * annotation.w;
              const py = rect[1] + point.y * annotation.h;
              return `${n(px)} ${n(py)} ${index === 0 ? "m" : "l"}`;
            })
            .join(" "),
        )
        .map((path) => `${path} S`)
        .join("\n");

      page.node.addAnnot(
        context.register(
          context.obj({
            ...shared,
            Subtype: "Stamp",
            Rect: rect,
            Name: "Signature",
            Contents: PDFString.of("Signature"),
            C: colour,
            CA: 1,
            AP: {
              N: appearance(
                doc,
                rect,
                `q\n${n(r)} ${n(g)} ${n(b)} RG ${n(width)} w 1 J 1 j\n${paths}\nQ\n`,
              ),
            },
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
