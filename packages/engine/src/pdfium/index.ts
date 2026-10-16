import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { redactWithPdfium, type RedactArea, type RedactionResult } from "./redact.js";
import {
  PasswordRequiredError,
  type DocHandle,
  type OutlineItem,
  type PdfEngine,
  type TextRun,
  type TimingSink,
} from "../types.js";

/**
 * The wasm binary must come from our own bundle. We never use the package's
 * DEFAULT_PDFIUM_WASM_URL: it points at a public CDN, which privacy invariants
 * 2 and 3 forbid (CLAUDE.md §1) — src/pdfium/no-cdn.test.ts guards that.
 */
export type PdfiumEngineOptions = {
  onTiming?: TimingSink;
} & ({ wasmBinary: ArrayBuffer | Uint8Array } | { wasmUrl: string });

// FPDF_GetLastError codes (public/fpdfview.h).
const ERR = new Map([
  [1, "unknown error"],
  [2, "file not found or could not be opened"],
  [3, "file not in PDF format or corrupted"],
  [4, "password required or incorrect password"],
  [5, "unsupported security scheme"],
  [6, "page not found or content error"],
]);

const FPDF_BGRA = 4;
const FPDF_ANNOT = 0x01;

class PdfiumDocHandle implements DocHandle {
  readonly #m: WrappedPdfiumModule;
  readonly #doc: number;
  readonly #dataPtr: number;
  readonly #pages = new Map<number, number>();
  readonly #count: number;
  #closed = false;

  constructor(m: WrappedPdfiumModule, doc: number, dataPtr: number) {
    this.#m = m;
    this.#doc = doc;
    this.#dataPtr = dataPtr;
    this.#count = m.FPDF_GetPageCount(doc);
  }

  pageCount(): number {
    return this.#count;
  }

  pageSize(index: number): { width: number; height: number } {
    this.#assertOpen();
    if (index < 0 || index >= this.#count) throw new RangeError(`page ${index} out of range`);
    // FS_SIZEF: two floats. This is the box size *before* /Rotate (measured: a
    // 90-degree page reports its portrait size), and it is read by index so a
    // 500-page document needs no page loads. We apply the rotation ourselves —
    // DocHandle.pageSize is the rotated size, which is what a viewer lays out.
    const ptr = this.#malloc(8);
    try {
      if (!this.#m.EPDF_GetPageSizeByIndexNormalized(this.#doc, index, ptr)) {
        throw new Error(`could not read size of page ${index}`);
      }
      const width = this.#m.pdfium.getValue(ptr, "float");
      const height = this.#m.pdfium.getValue(ptr + 4, "float");
      // PDFium reports rotation in quarter turns (FPDFPage_GetRotation).
      const quarterTurns = this.#m.EPDF_GetPageRotationByIndex(this.#doc, index);
      return quarterTurns % 2 === 0 ? { width, height } : { width: height, height: width };
    } finally {
      this.#free(ptr);
    }
  }

  async renderPage(index: number, scale: number): Promise<ImageBitmap> {
    this.#assertOpen();
    const { width: ptW, height: ptH } = this.pageSize(index);
    const w = Math.max(1, Math.ceil(ptW * scale));
    const h = Math.max(1, Math.ceil(ptH * scale));
    const page = this.#page(index);

    const buf = this.#malloc(w * h * 4);
    let bitmap = 0;
    try {
      bitmap = this.#m.FPDFBitmap_CreateEx(w, h, FPDF_BGRA, buf, w * 4);
      if (!bitmap) throw new Error("could not allocate a PDFium bitmap");
      this.#m.FPDFBitmap_FillRect(bitmap, 0, 0, w, h, 0xffffffff);
      this.#m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, w, h, 0, FPDF_ANNOT);

      // PDFium writes B,G,R,A; ImageData wants R,G,B,A. One pass, swapping as we
      // copy out of the wasm heap (which we must do anyway — it can move or grow).
      const src = this.#m.pdfium.HEAPU8.subarray(buf, buf + w * h * 4);
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = src[i + 2]!;
        rgba[i + 1] = src[i + 1]!;
        rgba[i + 2] = src[i]!;
        rgba[i + 3] = src[i + 3]!;
      }
      return await createImageBitmap(new ImageData(rgba, w, h));
    } finally {
      if (bitmap) this.#m.FPDFBitmap_Destroy(bitmap);
      this.#free(buf);
    }
  }

  async extractText(index: number): Promise<TextRun[]> {
    this.#assertOpen();
    const textPage = this.#m.FPDFText_LoadPage(this.#page(index));
    if (!textPage) return [];
    // Four doubles for the rect, plus a UTF-16 buffer reused per rect.
    const rectPtr = this.#malloc(32);
    try {
      const runs: TextRun[] = [];
      const rects = this.#m.FPDFText_CountRects(textPage, 0, -1);
      for (let i = 0; i < rects; i++) {
        if (
          !this.#m.FPDFText_GetRect(textPage, i, rectPtr, rectPtr + 8, rectPtr + 16, rectPtr + 24)
        ) {
          continue;
        }
        const left = this.#m.pdfium.getValue(rectPtr, "double");
        const top = this.#m.pdfium.getValue(rectPtr + 8, "double");
        const right = this.#m.pdfium.getValue(rectPtr + 16, "double");
        const bottom = this.#m.pdfium.getValue(rectPtr + 24, "double");

        // Passing a null buffer asks for the required length, in UTF-16 units.
        const len = this.#m.FPDFText_GetBoundedText(textPage, left, top, right, bottom, 0, 0);
        if (len <= 0) continue;
        const textPtr = this.#malloc(len * 2 + 2);
        try {
          const written = this.#m.FPDFText_GetBoundedText(
            textPage,
            left,
            top,
            right,
            bottom,
            textPtr,
            len,
          );
          // GetBoundedText does not promise a terminator, so write our own.
          this.#m.pdfium.setValue(textPtr + Math.max(0, written) * 2, 0, "i16");
          const text = this.#m.pdfium.UTF16ToString(textPtr);
          if (text !== "") {
            runs.push({ text, x: left, y: bottom, w: right - left, h: top - bottom });
          }
        } finally {
          this.#free(textPtr);
        }
      }
      return runs;
    } finally {
      this.#m.FPDFText_ClosePage(textPage);
      this.#free(rectPtr);
    }
  }

  async outline(): Promise<OutlineItem[]> {
    this.#assertOpen();
    // Bookmarks are a sibling-linked tree of first-child pointers. Depth is
    // capped because a malformed file can point a child back at its ancestor,
    // and malformed PDFs are normal (CLAUDE.md §4).
    const walk = (parent: number, depth: number): OutlineItem[] => {
      if (depth > 16) return [];
      const items: OutlineItem[] = [];
      let bookmark = this.#m.FPDFBookmark_GetFirstChild(this.#doc, parent);
      while (bookmark && items.length < 5000) {
        items.push({
          title: this.#bookmarkTitle(bookmark),
          page: this.#bookmarkPage(bookmark),
          children: walk(bookmark, depth + 1),
        });
        bookmark = this.#m.FPDFBookmark_GetNextSibling(this.#doc, bookmark);
      }
      return items;
    };
    return walk(0, 0);
  }

  /** Titles come back as UTF-16; the first call asks for the byte length. */
  #bookmarkTitle(bookmark: number): string {
    const bytes = this.#m.FPDFBookmark_GetTitle(bookmark, 0, 0);
    if (bytes <= 2) return "";
    const ptr = this.#malloc(bytes);
    try {
      this.#m.FPDFBookmark_GetTitle(bookmark, ptr, bytes);
      return this.#m.pdfium.UTF16ToString(ptr);
    } finally {
      this.#free(ptr);
    }
  }

  #bookmarkPage(bookmark: number): number | undefined {
    let dest = this.#m.FPDFBookmark_GetDest(this.#doc, bookmark);
    if (!dest) {
      // No direct destination: it may carry a GoTo action instead.
      const action = this.#m.FPDFBookmark_GetAction(bookmark);
      if (!action) return undefined;
      dest = this.#m.FPDFAction_GetDest(this.#doc, action);
      if (!dest) return undefined;
    }
    const index = this.#m.FPDFDest_GetDestPageIndex(this.#doc, dest);
    return index >= 0 ? index : undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const page of this.#pages.values()) this.#m.FPDF_ClosePage(page);
    this.#pages.clear();
    this.#m.FPDF_CloseDocument(this.#doc);
    this.#free(this.#dataPtr);
  }

  /** PDFium keeps reading the buffer after load, so pages are cached, not reloaded. */
  #page(index: number): number {
    const cached = this.#pages.get(index);
    if (cached !== undefined) return cached;
    const page = this.#m.FPDF_LoadPage(this.#doc, index);
    if (!page) throw new Error(`could not load page ${index}: ${lastError(this.#m)}`);
    this.#pages.set(index, page);
    return page;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("document is closed");
  }

  #malloc(bytes: number): number {
    const ptr = this.#m.pdfium.wasmExports.malloc(bytes);
    if (!ptr) throw new Error(`PDFium could not allocate ${bytes} bytes`);
    return ptr;
  }

  #free(ptr: number): void {
    this.#m.pdfium.wasmExports.free(ptr);
  }
}

function lastError(m: WrappedPdfiumModule): string {
  const code = m.FPDF_GetLastError();
  return ERR.get(code) ?? `error code ${code}`;
}

export type { RedactArea, RedactionResult, RedactRect } from "./redact.js";

/** PDFium's linear memory is its real footprint, and no browser memory API
 *  attributes it reliably, so the engine reports it for ADR 0002's benchmark. */
export type PdfiumEngine = PdfEngine & {
  wasmHeapBytes(): number;
  /**
   * Removes content inside the given areas and returns the new document, with a
   * verification pass. Lives on the engine rather than in packages/core because
   * only PDFium can edit page objects; pdf-lib cannot.
   */
  redact(bytes: Uint8Array, areas: RedactArea[]): Promise<RedactionResult>;
};

export async function createPdfiumEngine(opts: PdfiumEngineOptions): Promise<PdfiumEngine> {
  const t0 = performance.now();
  const wasmBinary = await resolveWasm(opts);
  const m = await init({
    wasmBinary,
    // Emscripten resolves the wasm filename before it looks at wasmBinary, so
    // locateFile must answer. A bare relative name can only ever be same-origin;
    // in practice wasmBinary above means it is never fetched at all.
    locateFile: (path: string) => path,
  });
  m.PDFiumExt_Init();
  opts.onTiming?.("parse", performance.now() - t0);

  /** Opens bytes just long enough to read one page's text, for verification. */
  async function textOf(bytes: Uint8Array, page: number) {
    const handle = await engine.open(bytes.buffer as ArrayBuffer);
    try {
      return await handle.extractText(page);
    } finally {
      handle.close();
    }
  }

  const engine: PdfiumEngine = {
    wasmHeapBytes: () => m.pdfium.HEAPU8.byteLength,

    redact: (bytes, areas) => redactWithPdfium(m, bytes, areas, textOf),

    async open(bytes, openOpts) {
      // Documents are immutable inputs (CLAUDE.md §4), and PDFium reads from this
      // allocation for the document's whole life, so it gets its own copy.
      const size = bytes.byteLength;
      const ptr = m.pdfium.wasmExports.malloc(size);
      if (!ptr) throw new Error(`PDFium could not allocate ${size} bytes`);
      m.pdfium.HEAPU8.set(new Uint8Array(bytes), ptr);

      const doc = m.FPDF_LoadMemDocument64(ptr, size, openOpts?.password ?? "");
      if (!doc) {
        const code = m.FPDF_GetLastError();
        m.pdfium.wasmExports.free(ptr);
        if (code === 4) throw new PasswordRequiredError();
        throw new Error(`PDFium could not open the document: ${ERR.get(code) ?? `code ${code}`}`);
      }
      return new PdfiumDocHandle(m, doc, ptr);
    },
  };

  return engine;
}

async function resolveWasm(opts: PdfiumEngineOptions): Promise<ArrayBuffer> {
  if ("wasmBinary" in opts) {
    const b = opts.wasmBinary;
    return b instanceof Uint8Array ? (b.slice().buffer as ArrayBuffer) : b;
  }
  const url = new URL(opts.wasmUrl, globalThis.location?.href ?? "file:///");
  if (globalThis.location && url.origin !== globalThis.location.origin) {
    throw new Error(`wasmUrl must be same-origin (got ${url.origin}); see docs/PRIVACY.md`);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch ${opts.wasmUrl}: ${res.status}`);
  return res.arrayBuffer();
}
