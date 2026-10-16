import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

/**
 * Editing the text that is already on the page, rather than writing a note over
 * it. This is what "Edit PDF" means in Acrobat and what an annotation is not:
 * the words in the content stream change, so copying, searching and extracting
 * all see the new text.
 *
 * PDFium exposes `FPDFText_SetText`, which replaces the string of an existing
 * text object while keeping its font, size, colour and position. That is the
 * whole trick: we are not laying text out, we are substituting a string into a
 * run the document already positioned.
 *
 * Two limits fall out of that, and the UI has to say so rather than hide them:
 *
 *  * **No reflow.** A run keeps its origin, so longer text runs on past where
 *    the old text ended instead of wrapping. Acrobat reflows within a detected
 *    paragraph; matching that means grouping runs into blocks and re-laying them
 *    out, which is a much larger piece of work.
 *  * **Fonts are usually subsets.** A PDF normally embeds only the glyphs it
 *    used, so typing a character the subset lacks can come out blank. Acrobat
 *    hits this too and offers to substitute a font; we report it instead.
 */

export interface EditableText {
  /** Index of the page object, which is what an edit addresses. */
  index: number;
  text: string;
  /** Box in PDF points, origin at the page's bottom-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  fontName: string;
  /** 0–1 RGB, so the editor can show the text in its real colour. */
  colour: [number, number, number];
}

export interface TextEdit {
  /** Source page index. */
  page: number;
  /** Index from `EditableText`, valid only for the bytes it was read from. */
  index: number;
  text: string;
}

export interface TextEditResult {
  bytes: Uint8Array;
  /** Edits applied. Fewer than asked for means some runs refused the change. */
  applied: number;
  /**
   * Runs whose new text could not be written, usually because the embedded font
   * subset has no glyph for a character that was typed.
   */
  rejected: { page: number; index: number; reason: string }[];
}

const FPDF_PAGEOBJ_TEXT = 1;

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

/** PDFium hands back UTF-16; the first call asks how many bytes it needs. */
function readUtf16(
  m: WrappedPdfiumModule,
  heap: Heap,
  read: (ptr: number, len: number) => number,
): string {
  const bytes = read(0, 0);
  if (bytes <= 2) return "";
  const ptr = heap.malloc(bytes);
  try {
    read(ptr, bytes);
    return m.pdfium.UTF16ToString(ptr);
  } finally {
    heap.free(ptr);
  }
}

/** The text runs on one page that can be edited in place. */
export function listEditableText(
  m: WrappedPdfiumModule,
  doc: number,
  pageIndex: number,
): EditableText[] {
  const heap = heapOf(m);
  const page = m.FPDF_LoadPage(doc, pageIndex);
  if (!page) throw new Error(`could not load page ${pageIndex}`);
  const textPage = m.FPDFText_LoadPage(page);

  try {
    const runs: EditableText[] = [];
    const bounds = heap.malloc(16);
    const scratch = heap.malloc(8);
    try {
      for (let i = 0; i < m.FPDFPage_CountObjects(page); i++) {
        const object = m.FPDFPage_GetObject(page, i);
        if (!object || m.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_TEXT) continue;

        const text = readUtf16(m, heap, (ptr, len) =>
          m.FPDFTextObj_GetText(object, textPage, ptr, len),
        );
        if (text.trim() === "") continue;

        if (!m.FPDFPageObj_GetBounds(object, bounds, bounds + 4, bounds + 8, bounds + 12)) {
          continue;
        }
        const left = m.pdfium.getValue(bounds, "float");
        const bottom = m.pdfium.getValue(bounds + 4, "float");
        const right = m.pdfium.getValue(bounds + 8, "float");
        const top = m.pdfium.getValue(bounds + 12, "float");

        m.FPDFTextObj_GetFontSize(object, scratch);
        const fontSize = m.pdfium.getValue(scratch, "float");

        const font = m.FPDFTextObj_GetFont(object);
        const fontName = font
          ? readUtf16(m, heap, (ptr, len) => m.FPDFFont_GetBaseFontName(font, ptr, len))
          : "";

        runs.push({
          index: i,
          text,
          x: left,
          y: bottom,
          w: right - left,
          h: top - bottom,
          fontSize,
          fontName,
          colour: fillColour(m, heap, object),
        });
      }
      return runs;
    } finally {
      heap.free(bounds);
      heap.free(scratch);
    }
  } finally {
    if (textPage) m.FPDFText_ClosePage(textPage);
    m.FPDF_ClosePage(page);
  }
}

function fillColour(m: WrappedPdfiumModule, heap: Heap, object: number): [number, number, number] {
  const ptr = heap.malloc(16);
  try {
    if (!m.FPDFPageObj_GetFillColor(object, ptr, ptr + 4, ptr + 8, ptr + 12)) return [0, 0, 0];
    return [
      m.pdfium.getValue(ptr, "i32") / 255,
      m.pdfium.getValue(ptr + 4, "i32") / 255,
      m.pdfium.getValue(ptr + 8, "i32") / 255,
    ];
  } finally {
    heap.free(ptr);
  }
}

/** FPDF_WIDESTRING is UTF-16LE with a null terminator, in wasm memory. */
function wideString(m: WrappedPdfiumModule, heap: Heap, text: string): number {
  const ptr = heap.malloc((text.length + 1) * 2);
  m.pdfium.stringToUTF16(text, ptr, (text.length + 1) * 2);
  return ptr;
}

/**
 * Applies the edits and returns the new document. `saveCopy` is passed in so
 * this shares the writer with the redaction path rather than owning a second
 * copy of it.
 */
export function applyTextEdits(
  m: WrappedPdfiumModule,
  doc: number,
  edits: TextEdit[],
  saveCopy: () => Uint8Array,
): Omit<TextEditResult, "bytes"> & { bytes: Uint8Array } {
  const heap = heapOf(m);
  const rejected: TextEditResult["rejected"] = [];
  let applied = 0;

  // Group by page so each page is loaded and regenerated once.
  const byPage = new Map<number, TextEdit[]>();
  for (const edit of edits) {
    byPage.set(edit.page, [...(byPage.get(edit.page) ?? []), edit]);
  }

  for (const [pageIndex, pageEdits] of byPage) {
    const page = m.FPDF_LoadPage(doc, pageIndex);
    if (!page) throw new Error(`could not load page ${pageIndex}`);
    try {
      let changed = false;
      for (const edit of pageEdits) {
        const object = m.FPDFPage_GetObject(page, edit.index);
        if (!object || m.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_TEXT) {
          rejected.push({
            page: pageIndex,
            index: edit.index,
            reason: "that run is no longer there; reopen the page and try again",
          });
          continue;
        }
        const ptr = wideString(m, heap, edit.text);
        try {
          if (m.FPDFText_SetText(object, ptr)) {
            applied++;
            changed = true;
          } else {
            rejected.push({
              page: pageIndex,
              index: edit.index,
              reason:
                "PDFium refused the new text, usually because the embedded font " +
                "has no glyph for a character that was typed",
            });
          }
        } finally {
          heap.free(ptr);
        }
      }
      if (changed && !m.FPDFPage_GenerateContent(page)) {
        throw new Error(`could not rewrite page ${pageIndex} after editing`);
      }
    } finally {
      m.FPDF_ClosePage(page);
    }
  }

  return { bytes: saveCopy(), applied, rejected };
}
