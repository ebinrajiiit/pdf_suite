import { PDFDocument, degrees } from "pdf-lib";

// Every op: bytes in, new bytes out. The caller's buffer is never mutated
// (CLAUDE.md §4) — pdf-lib parses into its own structures and we always save
// into a fresh document.

export type PdfBytes = Uint8Array;

/** Inclusive, 0-based page range. */
export type PageRange = [number, number];

async function load(input: PdfBytes): Promise<PDFDocument> {
  return PDFDocument.load(input, { updateMetadata: false });
}

/** Copies `indices` of `src` into a new document, in the order given. */
async function copyInto(src: PDFDocument, indices: number[]): Promise<PdfBytes> {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  for (const page of pages) out.addPage(page);
  return out.save();
}

export async function merge(inputs: PdfBytes[]): Promise<PdfBytes> {
  if (inputs.length === 0) throw new Error("merge needs at least one document");
  const out = await PDFDocument.create();
  for (const input of inputs) {
    const src = await load(input);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return out.save();
}

export async function split(input: PdfBytes, ranges: PageRange[]): Promise<PdfBytes[]> {
  const src = await load(input);
  const count = src.getPageCount();
  return Promise.all(
    ranges.map(([start, end]) => {
      if (start < 0 || end >= count || start > end) {
        throw new RangeError(`range ${start}-${end} outside a ${count}-page document`);
      }
      const indices = [];
      for (let i = start; i <= end; i++) indices.push(i);
      return copyInto(src, indices);
    }),
  );
}

/**
 * `order` lists source page indices in their new positions, so it is also how a
 * viewer can show a reordering before anything is written: pages the order omits
 * are dropped, which is how "delete pages" will work too.
 */
export async function reorder(input: PdfBytes, order: number[]): Promise<PdfBytes> {
  const src = await load(input);
  const count = src.getPageCount();
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError(`page ${index} outside a ${count}-page document`);
    }
  }
  if (new Set(order).size !== order.length) throw new Error("order repeats a page");
  return copyInto(src, order);
}

/** Relative to each page's current rotation, as a viewer's rotate button is. */
export async function rotate(
  input: PdfBytes,
  pages: number[],
  by: 90 | 180 | 270,
): Promise<PdfBytes> {
  const doc = await load(input);
  const count = doc.getPageCount();
  for (const index of pages) {
    if (index < 0 || index >= count) {
      throw new RangeError(`page ${index} outside a ${count}-page document`);
    }
    const page = doc.getPage(index);
    page.setRotation(degrees((page.getRotation().angle + by) % 360));
  }
  return doc.save();
}
