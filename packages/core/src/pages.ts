import {
  degrees,
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { place } from "./stamp.js";
import type { PdfBytes } from "./ops.js";

/**
 * The page-level work Acrobat keeps under Organize and Edit: cropping,
 * watermarks and backgrounds, and page labels.
 *
 * All three are things an institution does to a document before it goes out —
 * trim the scanner's black edge, mark a draft as a draft, number the front
 * matter in roman — and none of them needs the rendering engine.
 */

/** A box in PDF points, as the reader sees the page. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Crops pages to the box given, in the coordinates the reader sees.
 *
 * Cropping is not deletion: `/CropBox` changes what is shown, and the content
 * outside it stays in the file. That is how every PDF tool behaves, and it is
 * worth knowing before cropping something sensitive — redaction is the tool for
 * that, and this one says so in the UI.
 */
export async function cropPages(input: PdfBytes, box: Box, pages?: number[]): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const count = doc.getPageCount();
  const wanted = pages ?? doc.getPageIndices();

  for (const index of wanted) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError(`page ${index} outside a ${count}-page document`);
    }
    const page = doc.getPage(index);
    const { width, height } = page.getSize();
    const rotation = page.getRotation().angle;
    // The box arrives in the reader's frame; /CropBox is in the page's own.
    const a = place(width, height, rotation, box.x, box.y);
    const b = place(width, height, rotation, box.x + box.w, box.y + box.h);
    const left = Math.max(0, Math.min(a.x, b.x));
    const bottom = Math.max(0, Math.min(a.y, b.y));
    const right = Math.min(width, Math.max(a.x, b.x));
    const top = Math.min(height, Math.max(a.y, b.y));
    if (right - left < 1 || top - bottom < 1) {
      throw new RangeError("a crop box has to leave something of the page");
    }
    page.setCropBox(left, bottom, right - left, top - bottom);
  }
  return doc.save();
}

/** Puts every page's crop back to its media box. */
export async function uncropPages(input: PdfBytes): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of("CropBox"));
  }
  return doc.save();
}

export interface WatermarkOptions {
  text: string;
  /** 0-1. Acrobat's default is about a quarter. */
  opacity?: number | undefined;
  /** Degrees anticlockwise. 45 is the diagonal everyone expects. */
  rotation?: number | undefined;
  /** Points. Default is sized to the page. */
  size?: number | undefined;
  colour?: [number, number, number] | undefined;
  /**
   * Behind the page's own content, as a background, or over it. Behind is
   * what "background" means in Acrobat, and it is the one that stays readable.
   */
  placement?: "behind" | "front" | undefined;
  pages?: number[] | undefined;
}

/**
 * Draws a watermark across pages.
 *
 * Behind the content means prepending a content stream rather than appending
 * one: a PDF page draws its streams in order, so the only way to be underneath
 * is to go first.
 */
export async function watermark(input: PdfBytes, options: WatermarkOptions): Promise<PdfBytes> {
  if (options.text.trim() === "") throw new Error("a watermark needs some text");

  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const opacity = options.opacity ?? 0.25;
  const rotation = options.rotation ?? 45;
  const [r, g, b] = options.colour ?? [0.5, 0.5, 0.5];
  const count = doc.getPageCount();
  const wanted = options.pages ?? doc.getPageIndices();

  for (const index of wanted) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError(`page ${index} outside a ${count}-page document`);
    }
    const page = doc.getPage(index);
    const { width, height } = page.getSize();
    // Sized to cross the page, unless a size was asked for.
    const size = options.size ?? Math.min(width, height) / Math.max(options.text.length, 4);
    const textWidth = font.widthOfTextAtSize(options.text, size);
    const radians = (rotation * Math.PI) / 180;
    // Centre the rotated text on the page's centre.
    const x = width / 2 - (textWidth / 2) * Math.cos(radians) + (size / 2) * Math.sin(radians);
    const y = height / 2 - (textWidth / 2) * Math.sin(radians) - (size / 2) * Math.cos(radians);

    if ((options.placement ?? "behind") === "behind") {
      // The resources first: each call picks a name that is free on this page,
      // and the stream has to use the name it picked. Naming them ourselves
      // would reference resources the page does not have, and the watermark
      // would simply not draw.
      const fontName = page.node.newFontDictionary("F-wm", font.ref).asString();
      const stateName = page.node
        .newExtGState(
          "GS-wm",
          doc.context.register(doc.context.obj({ Type: "ExtGState", ca: opacity, CA: opacity })),
        )
        .asString();

      // A background has to be drawn before the page's own content, so it goes
      // into a stream of its own at the front of /Contents.
      const operators = doc.context.flateStream(
        `q ${stateName} gs ${r} ${g} ${b} rg BT ${fontName} ${size} Tf ` +
          `${Math.cos(radians)} ${Math.sin(radians)} ${-Math.sin(radians)} ` +
          `${Math.cos(radians)} ${x} ${y} Tm (${escapeText(options.text)}) Tj ET Q\n`,
      );
      const ref = doc.context.register(operators);
      const contents = page.node.get(PDFName.of("Contents"));
      const existing =
        contents instanceof PDFArray
          ? contents.asArray()
          : contents === undefined
            ? []
            : [contents];
      page.node.set(PDFName.of("Contents"), doc.context.obj([ref, ...existing]));
    } else {
      page.drawText(options.text, {
        x,
        y,
        size,
        font,
        color: rgb(r, g, b),
        rotate: degrees(rotation),
        opacity,
      });
    }
  }

  return doc.save();
}

function escapeText(text: string): string {
  return text.replace(/([()\\])/g, "\\$1");
}

/** How a run of pages is numbered in the viewer's own page box. */
export interface PageLabelRange {
  /** Display position the run starts at. */
  from: number;
  /** D is 1,2,3; r and R roman; a and A letters; none means prefix only. */
  style?: "D" | "r" | "R" | "a" | "A" | "none" | undefined;
  prefix?: string | undefined;
  /** The number the run starts at. Default 1. */
  start?: number | undefined;
}

/**
 * Sets `/PageLabels`, which is what the viewer's page box shows.
 *
 * This is a different thing from the numbers printed on the page by
 * `stampPages`: a document can be numbered i, ii, iii for its front matter and
 * 1, 2, 3 after it, and a reader asking for "page 4" should land where the
 * document says page 4 is.
 */
export async function setPageLabels(input: PdfBytes, ranges: PageLabelRange[]): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const count = doc.getPageCount();

  if (ranges.length === 0) {
    doc.catalog.delete(PDFName.of("PageLabels"));
    return doc.save();
  }

  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  if (sorted[0]?.from !== 0) {
    throw new RangeError("page labels have to start at the first page");
  }

  const nums = [];
  for (const range of sorted) {
    if (!Number.isInteger(range.from) || range.from < 0 || range.from >= count) {
      throw new RangeError(`page ${range.from} outside a ${count}-page document`);
    }
    const entry = doc.context.obj({});
    if (range.style && range.style !== "none") entry.set(PDFName.of("S"), PDFName.of(range.style));
    if (range.prefix) entry.set(PDFName.of("P"), PDFString.of(range.prefix));
    if (range.start !== undefined && range.start !== 1) {
      entry.set(PDFName.of("St"), PDFNumber.of(range.start));
    }
    nums.push(PDFNumber.of(range.from), entry);
  }

  doc.catalog.set(PDFName.of("PageLabels"), doc.context.obj({ Nums: nums }));
  return doc.save();
}
