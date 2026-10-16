import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

/**
 * True redaction: the content is removed from the document, not covered up.
 *
 * Painting a black rectangle over text is the failure that makes news — the
 * words are still in the file and any reader can extract them. This removes the
 * page objects that touch the area, regenerates the page content, then draws an
 * opaque box so the gap is visibly deliberate, and finally re-extracts the text
 * to prove nothing is left behind.
 *
 * Granularity is PDFium's: a text object is usually a run or a line, so an
 * object that merely overlaps the area is removed whole. That errs towards
 * removing too much, which is the safe direction for redaction — but it is
 * visible, and `removed` reports how many objects went.
 */

/** A box in PDF points, origin at the page's bottom-left. */
export interface RedactRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RedactArea {
  /** Source page index. */
  page: number;
  rects: RedactRect[];
}

export interface RedactionResult {
  bytes: Uint8Array;
  /** Page objects removed, by page index. */
  removed: Record<number, number>;
  /**
   * True when re-reading the result found no text inside any redacted box. A
   * false here means the redaction did not fully work and must not be trusted.
   */
  verified: boolean;
  /** Text that survived inside a redacted area, if any. Empty when verified. */
  leftovers: { page: number; text: string }[];
}

const FPDF_FILLMODE_WINDING = 1;

function overlaps(a: RedactRect, bounds: { l: number; b: number; r: number; t: number }): boolean {
  return bounds.l < a.x + a.w && bounds.r > a.x && bounds.b < a.y + a.h && bounds.t > a.y;
}

/**
 * Removes every page object touching the given areas and returns the new
 * document. `extractText` is the adapter's own text extraction, used to verify.
 */
export async function redactWithPdfium(
  m: WrappedPdfiumModule,
  input: Uint8Array,
  areas: RedactArea[],
  extractText: (
    bytes: Uint8Array,
    page: number,
  ) => Promise<{ text: string; x: number; y: number; w: number; h: number }[]>,
): Promise<RedactionResult> {
  if (areas.length === 0) throw new Error("no areas to redact");

  const malloc = (bytes: number) => {
    const ptr = m.pdfium.wasmExports.malloc(bytes);
    if (!ptr) throw new Error(`PDFium could not allocate ${bytes} bytes`);
    return ptr;
  };
  const free = (ptr: number) => m.pdfium.wasmExports.free(ptr);

  const dataPtr = malloc(input.byteLength);
  m.pdfium.HEAPU8.set(input, dataPtr);
  const doc = m.FPDF_LoadMemDocument64(dataPtr, input.byteLength, "");
  if (!doc) {
    free(dataPtr);
    throw new Error("PDFium could not open the document to redact it");
  }

  const removed: Record<number, number> = {};
  try {
    const pageCount = m.FPDF_GetPageCount(doc);
    for (const area of areas) {
      if (area.page < 0 || area.page >= pageCount) {
        throw new RangeError(`redaction page ${area.page} outside a ${pageCount}-page document`);
      }
      if (area.rects.length === 0) continue;

      const page = m.FPDF_LoadPage(doc, area.page);
      if (!page) throw new Error(`could not load page ${area.page}`);
      try {
        const bounds = malloc(16);
        let count = 0;
        try {
          // Backwards, because removing an object shifts the indices after it.
          for (let i = m.FPDFPage_CountObjects(page) - 1; i >= 0; i--) {
            const object = m.FPDFPage_GetObject(page, i);
            if (!object) continue;
            if (!m.FPDFPageObj_GetBounds(object, bounds, bounds + 4, bounds + 8, bounds + 12)) {
              continue;
            }
            const box = {
              l: m.pdfium.getValue(bounds, "float"),
              b: m.pdfium.getValue(bounds + 4, "float"),
              r: m.pdfium.getValue(bounds + 8, "float"),
              t: m.pdfium.getValue(bounds + 12, "float"),
            };
            if (!area.rects.some((rect) => overlaps(rect, box))) continue;

            if (m.FPDFPage_RemoveObject(page, object)) {
              // Removing detaches it; destroying frees it.
              m.FPDFPageObj_Destroy(object);
              count++;
            }
          }
        } finally {
          free(bounds);
        }
        removed[area.page] = count;

        // An opaque box, so a reader can see that something was taken out.
        for (const rect of area.rects) {
          const box = m.FPDFPageObj_CreateNewRect(rect.x, rect.y, rect.w, rect.h);
          if (!box) continue;
          m.FPDFPageObj_SetFillColor(box, 0, 0, 0, 255);
          m.FPDFPath_SetDrawMode(box, FPDF_FILLMODE_WINDING, false);
          m.FPDFPage_InsertObject(page, box);
        }

        if (!m.FPDFPage_GenerateContent(page)) {
          throw new Error(`could not rewrite page ${area.page} after redacting`);
        }
      } finally {
        m.FPDF_ClosePage(page);
      }
    }

    const bytes = saveCopy(m, doc, malloc, free);

    // Verify against the saved bytes, not the in-memory document: what matters
    // is what the file contains.
    const leftovers: { page: number; text: string }[] = [];
    for (const area of areas) {
      for (const run of await extractText(bytes, area.page)) {
        if (run.text.trim() === "") continue;
        const box = { l: run.x, b: run.y, r: run.x + run.w, t: run.y + run.h };
        if (area.rects.some((rect) => overlaps(rect, box))) {
          leftovers.push({ page: area.page, text: run.text });
        }
      }
    }

    return { bytes, removed, verified: leftovers.length === 0, leftovers };
  } finally {
    m.FPDF_CloseDocument(doc);
    free(dataPtr);
  }
}

function saveCopy(
  m: WrappedPdfiumModule,
  doc: number,
  malloc: (bytes: number) => number,
  free: (ptr: number) => void,
): Uint8Array {
  const writer = m.PDFiumExt_OpenFileWriter();
  if (!writer) throw new Error("PDFium could not open a writer");
  try {
    if (!m.PDFiumExt_SaveAsCopy(doc, writer)) {
      throw new Error("PDFium could not write the redacted document");
    }
    const size = m.PDFiumExt_GetFileWriterSize(writer);
    const ptr = malloc(size);
    try {
      m.PDFiumExt_GetFileWriterData(writer, ptr, size);
      // Copy out of the wasm heap, which can move or be freed under us.
      return m.pdfium.HEAPU8.slice(ptr, ptr + size);
    } finally {
      free(ptr);
    }
  } finally {
    m.PDFiumExt_CloseFileWriter(writer);
  }
}
