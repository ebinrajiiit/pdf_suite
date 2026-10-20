import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

/**
 * Moving, resizing and removing the images already on a page — the half of
 * Acrobat's "Edit PDF" that is not text.
 *
 * An image on a PDF page is a unit square drawn through a matrix: the matrix is
 * the placement. Moving one is a change to its translation, resizing it a
 * change to its scale, and neither touches the image data at all. That is why
 * this is cheap where replacing the picture would not be.
 */

const FPDF_PAGEOBJ_IMAGE = 3;

export interface PageImage {
  /** Index of the page object, which is what an edit addresses. */
  index: number;
  /** Box in PDF points, origin at the page's bottom-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The stored picture's own size, which is what resizing trades against. */
  pixelWidth: number;
  pixelHeight: number;
}

export type ImageEdit =
  | { page: number; index: number; action: "remove" }
  | { page: number; index: number; action: "place"; x: number; y: number; w: number; h: number }
  /**
   * Replaces the picture while leaving the frame alone — the matrix stays, so
   * the new picture lands exactly where the old one was, at the same size.
   * Pixels are RGBA, as a canvas gives them.
   */
  | {
      page: number;
      index: number;
      action: "replace";
      width: number;
      height: number;
      pixels: Uint8Array;
    }
  /**
   * Turns the picture a quarter at a time, about the centre of where it sits.
   * This one is written as a nudge to the matrix already there rather than as a
   * fresh one: turning is relative by nature, and composing the turn is what
   * lets it be done twice without knowing which way up the picture started.
   */
  | { page: number; index: number; action: "turn"; quarters: 1 | 2 | 3 };

export interface ImageEditResult {
  bytes: Uint8Array;
  applied: number;
  rejected: { page: number; index: number; reason: string }[];
}

interface Heap {
  malloc(bytes: number): number;
  free(ptr: number): void;
}

function heapOf(m: WrappedPdfiumModule): Heap {
  return {
    malloc(bytes) {
      const ptr = m.pdfium.wasmExports.malloc(bytes);
      if (!ptr) throw new Error(`PDFium could not allocate ${bytes} bytes`);
      return ptr;
    },
    free(ptr) {
      m.pdfium.wasmExports.free(ptr);
    },
  };
}

/** PDFium's BGRA format, which is what its bitmaps are laid out as. */
const FPDFBitmap_BGRA = 4;

/**
 * Puts new pixels into an existing image object, keeping its placement.
 *
 * The pixels arrive as RGBA, which is what a canvas produces; PDFium wants
 * BGRA, so the two channels are swapped on the way in. The bitmap is handed to
 * PDFium, which copies it, and destroyed here — PDFium does not take ownership
 * and a bitmap left behind is a leak in a long session.
 */
function setPixels(
  m: WrappedPdfiumModule,
  heap: Heap,
  doc: number,
  object: number,
  width: number,
  height: number,
  rgba: Uint8Array,
): boolean {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) return false;

  const stride = width * 4;
  const buffer = heap.malloc(stride * height);
  try {
    const target = m.pdfium.HEAPU8.subarray(buffer, buffer + stride * height);
    for (let i = 0; i < width * height; i++) {
      const at = i * 4;
      target[at] = rgba[at + 2]!; // blue
      target[at + 1] = rgba[at + 1]!; // green
      target[at + 2] = rgba[at]!; // red
      target[at + 3] = rgba[at + 3]!; // alpha
    }

    const bitmap = m.FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA, buffer, stride);
    if (!bitmap) return false;
    try {
      // No pages are passed: the object is already on one, and passing it
      // again is how a picture ends up drawn twice.
      return m.FPDFImageObj_SetBitmap(0, 0, object, bitmap);
    } finally {
      m.FPDFBitmap_Destroy(bitmap);
    }
  } finally {
    heap.free(buffer);
  }
}

/**
 * The pixels of one placed image, as RGBA.
 *
 * PDFium renders the image as it appears — with its mask and colour space
 * applied — which is what makes this usable for re-encoding it smaller. The
 * bitmap it returns is ours to destroy.
 */
export function imagePixels(
  m: WrappedPdfiumModule,
  doc: number,
  pageIndex: number,
  index: number,
): { width: number; height: number; rgba: Uint8Array } | undefined {
  const page = m.FPDF_LoadPage(doc, pageIndex);
  if (!page) throw new Error(`could not load page ${pageIndex}`);
  try {
    const object = m.FPDFPage_GetObject(page, index);
    if (!object || m.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_IMAGE) return undefined;

    const bitmap = m.FPDFImageObj_GetRenderedBitmap(doc, page, object);
    if (!bitmap) return undefined;
    try {
      const width = m.FPDFBitmap_GetWidth(bitmap);
      const height = m.FPDFBitmap_GetHeight(bitmap);
      const stride = m.FPDFBitmap_GetStride(bitmap);
      const buffer = m.FPDFBitmap_GetBuffer(bitmap);
      if (width <= 0 || height <= 0 || !buffer) return undefined;

      // BGRA out of PDFium, RGBA in: the same swap as on the way in.
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        const row = buffer + y * stride;
        for (let x = 0; x < width; x++) {
          const from = row + x * 4;
          const to = (y * width + x) * 4;
          rgba[to] = m.pdfium.HEAPU8[from + 2] ?? 0;
          rgba[to + 1] = m.pdfium.HEAPU8[from + 1] ?? 0;
          rgba[to + 2] = m.pdfium.HEAPU8[from] ?? 0;
          rgba[to + 3] = m.pdfium.HEAPU8[from + 3] ?? 255;
        }
      }
      return { width, height, rgba };
    } finally {
      m.FPDFBitmap_Destroy(bitmap);
    }
  } finally {
    m.FPDF_ClosePage(page);
  }
}

/** The images on one page. */
export function listImages(m: WrappedPdfiumModule, doc: number, pageIndex: number): PageImage[] {
  const heap = heapOf(m);
  const page = m.FPDF_LoadPage(doc, pageIndex);
  if (!page) throw new Error(`could not load page ${pageIndex}`);
  const bounds = heap.malloc(16);
  const size = heap.malloc(8);

  try {
    const images: PageImage[] = [];
    for (let i = 0; i < m.FPDFPage_CountObjects(page); i++) {
      const object = m.FPDFPage_GetObject(page, i);
      if (!object || m.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_IMAGE) continue;
      if (!m.FPDFPageObj_GetBounds(object, bounds, bounds + 4, bounds + 8, bounds + 12)) continue;

      const left = m.pdfium.getValue(bounds, "float");
      const bottom = m.pdfium.getValue(bounds + 4, "float");
      const right = m.pdfium.getValue(bounds + 8, "float");
      const top = m.pdfium.getValue(bounds + 12, "float");

      let pixelWidth = 0;
      let pixelHeight = 0;
      if (m.FPDFImageObj_GetImagePixelSize(object, size, size + 4)) {
        pixelWidth = m.pdfium.getValue(size, "i32");
        pixelHeight = m.pdfium.getValue(size + 4, "i32");
      }

      images.push({
        index: i,
        x: left,
        y: bottom,
        w: right - left,
        h: top - bottom,
        pixelWidth,
        pixelHeight,
      });
    }
    return images;
  } finally {
    heap.free(bounds);
    heap.free(size);
    m.FPDF_ClosePage(page);
  }
}

/**
 * Applies the edits and returns the new document.
 *
 * Placement is written as a fresh matrix rather than as a nudge to the one
 * already there: an image's matrix carries its rotation and skew as well as its
 * position, and composing a move onto an unknown matrix is how a picture ends
 * up sheared. The cost is that a rotated image snaps upright when it is moved,
 * which is visible and recoverable; silent shearing is neither.
 */
export function applyImageEdits(
  m: WrappedPdfiumModule,
  doc: number,
  edits: ImageEdit[],
  saveCopy: () => Uint8Array,
): ImageEditResult {
  const heap = heapOf(m);
  const rejected: ImageEditResult["rejected"] = [];
  let applied = 0;

  const byPage = new Map<number, ImageEdit[]>();
  for (const edit of edits) byPage.set(edit.page, [...(byPage.get(edit.page) ?? []), edit]);

  for (const [pageIndex, pageEdits] of byPage) {
    const page = m.FPDF_LoadPage(doc, pageIndex);
    if (!page) throw new Error(`could not load page ${pageIndex}`);
    const matrix = heap.malloc(24);

    try {
      let changed = false;
      // Removals shift every index after them, so the highest goes first.
      const ordered = [...pageEdits].sort((a, b) => b.index - a.index);

      for (const edit of ordered) {
        const object = m.FPDFPage_GetObject(page, edit.index);
        if (!object || m.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_IMAGE) {
          rejected.push({
            page: pageIndex,
            index: edit.index,
            reason: "that image is no longer there; reopen the page and try again",
          });
          continue;
        }

        if (edit.action === "remove") {
          if (m.FPDFPage_RemoveObject(page, object)) {
            m.FPDFPageObj_Destroy(object);
            applied++;
            changed = true;
          } else {
            rejected.push({
              page: pageIndex,
              index: edit.index,
              reason: "PDFium refused to remove that image",
            });
          }
          continue;
        }

        if (edit.action === "turn") {
          if (!m.FPDFPageObj_GetBounds(object, matrix, matrix + 4, matrix + 8, matrix + 12)) {
            rejected.push({
              page: pageIndex,
              index: edit.index,
              reason: "PDFium could not say where that image is",
            });
            continue;
          }
          const cx =
            (m.pdfium.getValue(matrix, "float") + m.pdfium.getValue(matrix + 8, "float")) / 2;
          const cy =
            (m.pdfium.getValue(matrix + 4, "float") + m.pdfium.getValue(matrix + 12, "float")) / 2;
          // Clockwise, since that is what "turn right" means to a reader.
          const angle = (-edit.quarters * Math.PI) / 2;
          const cos = Math.round(Math.cos(angle));
          const sin = Math.round(Math.sin(angle));
          // Rotation about (cx, cy): move the centre to the origin, turn, move
          // it back. Transform concatenates onto the matrix the object has, so
          // the picture's own rotation and skew survive.
          m.FPDFPageObj_Transform(
            object,
            cos,
            sin,
            -sin,
            cos,
            cx - cx * cos + cy * sin,
            cy - cx * sin - cy * cos,
          );
          applied++;
          changed = true;
          continue;
        }

        if (edit.action === "replace") {
          const written = setPixels(m, heap, doc, object, edit.width, edit.height, edit.pixels);
          if (written) {
            applied++;
            changed = true;
          } else {
            rejected.push({
              page: pageIndex,
              index: edit.index,
              reason: "PDFium refused the replacement picture",
            });
          }
          continue;
        }

        // The unit square scaled to the box asked for, placed at its corner.
        [edit.w, 0, 0, edit.h, edit.x, edit.y].forEach((value, i) =>
          m.pdfium.setValue(matrix + i * 4, value, "float"),
        );
        if (m.FPDFPageObj_SetMatrix(object, matrix)) {
          applied++;
          changed = true;
        } else {
          rejected.push({
            page: pageIndex,
            index: edit.index,
            reason: "PDFium refused to move that image",
          });
        }
      }

      if (changed && !m.FPDFPage_GenerateContent(page)) {
        throw new Error(`could not rewrite page ${pageIndex} after editing images`);
      }
    } finally {
      heap.free(matrix);
      m.FPDF_ClosePage(page);
    }
  }

  return { bytes: saveCopy(), applied, rejected };
}
