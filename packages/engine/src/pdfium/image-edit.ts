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
  | { page: number; index: number; action: "place"; x: number; y: number; w: number; h: number };

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
