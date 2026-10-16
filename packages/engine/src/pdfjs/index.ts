import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import {
  PasswordRequiredError,
  type DocHandle,
  type PdfEngine,
  type TextRun,
  type TimingSink,
} from "../types.js";

/**
 * Every asset URL is required and must be same-origin: the CSP is `connect-src
 * 'self'` and pdf.js would otherwise reach for its CDN defaults (docs/PRIVACY.md).
 * The caller (apps/web) passes URLs produced by the bundler from our own bundle.
 */
export interface PdfjsEngineOptions {
  /** URL of the bundled pdf.worker.mjs. */
  workerSrc: string;
  /** Directory URL of the bundled cmaps (CJK encodings), trailing slash. */
  cMapUrl?: string;
  /** Directory URL of the bundled standard fonts, trailing slash. */
  standardFontDataUrl?: string;
  /** Directory URL of the bundled pdf.js wasm (JPEG 2000, colour management), trailing slash. */
  wasmUrl?: string;
  /** Directory URL of the bundled ICC profiles, trailing slash. */
  iccUrl?: string;
  onTiming?: TimingSink;
}

class PdfjsDocHandle implements DocHandle {
  readonly #doc: PDFDocumentProxy;
  readonly #task: PDFDocumentLoadingTask;
  readonly #sizes: { width: number; height: number }[];

  constructor(
    doc: PDFDocumentProxy,
    task: PDFDocumentLoadingTask,
    sizes: { width: number; height: number }[],
  ) {
    this.#doc = doc;
    this.#task = task;
    this.#sizes = sizes;
  }

  pageCount(): number {
    return this.#doc.numPages;
  }

  pageSize(index: number): { width: number; height: number } {
    const size = this.#sizes[index];
    if (!size) throw new RangeError(`page ${index} out of range`);
    return size;
  }

  async renderPage(index: number, scale: number): Promise<ImageBitmap> {
    const page = await this.#doc.getPage(index + 1);
    try {
      const viewport = page.getViewport({ scale });
      const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("could not get a 2D context");
      await page.render({
        canvas: null,
        // Rendering happens in a worker, so this is an OffscreenCanvas context:
        // structurally what pdf.js uses, but not the DOM type its .d.ts declares.
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      return canvas.transferToImageBitmap();
    } finally {
      page.cleanup();
    }
  }

  async extractText(index: number): Promise<TextRun[]> {
    const page = await this.#doc.getPage(index + 1);
    try {
      const content = await page.getTextContent();
      const runs: TextRun[] = [];
      for (const item of content.items) {
        // Only TextItems carry a transform; TextMarkedContent entries do not.
        if (!("str" in item) || item.str === "") continue;
        const t = item.transform as number[];
        runs.push({
          text: item.str,
          x: t[4] ?? 0,
          y: t[5] ?? 0,
          w: item.width,
          h: item.height,
        });
      }
      return runs;
    } finally {
      page.cleanup();
    }
  }

  close(): void {
    // Destroying the loading task tears down the worker; the proxy has no destroy().
    void this.#task.destroy();
  }
}

export function createPdfjsEngine(opts: PdfjsEngineOptions): PdfEngine {
  if (!opts.workerSrc) throw new Error("pdf.js needs a same-origin workerSrc");
  GlobalWorkerOptions.workerSrc = opts.workerSrc;

  return {
    async open(bytes, openOpts) {
      // pdf.js transfers the buffer to its worker, detaching it. Documents are
      // immutable inputs (CLAUDE.md §4), so hand it a copy.
      const data = new Uint8Array(bytes.byteLength);
      data.set(new Uint8Array(bytes));

      const t0 = performance.now();
      let task: PDFDocumentLoadingTask;
      let doc: PDFDocumentProxy;
      try {
        task = getDocument({
          data,
          ...(openOpts?.password === undefined ? {} : { password: openOpts.password }),
          ...(opts.cMapUrl === undefined ? {} : { cMapUrl: opts.cMapUrl, cMapPacked: true }),
          ...(opts.standardFontDataUrl === undefined
            ? {}
            : { standardFontDataUrl: opts.standardFontDataUrl }),
          ...(opts.wasmUrl === undefined ? {} : { wasmUrl: opts.wasmUrl }),
          ...(opts.iccUrl === undefined ? {} : { iccUrl: opts.iccUrl }),
          // Never let the worker fetch assets itself, and never fall back to
          // system fonts (both would escape our bundle).
          useWorkerFetch: false,
          useSystemFonts: false,
          // Render what we can of a malformed file; qpdf repair is the fallback.
          stopAtErrors: false,
        });
        doc = await task.promise;
      } catch (err) {
        if (err instanceof Error && err.name === "PasswordException") {
          throw new PasswordRequiredError(err.message);
        }
        throw err;
      }
      const parsed = performance.now();
      opts.onTiming?.("parse", parsed - t0);

      // DocHandle.pageSize is synchronous, so every page's size must be known up
      // front. pdf.js only parses page dictionaries on demand, so this costs one
      // getPage per page at open time — see ADR 0002.
      const sizes: { width: number; height: number }[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const { width, height } = page.getViewport({ scale: 1 });
        sizes.push({ width, height });
      }
      opts.onTiming?.("pageSizes", performance.now() - parsed);

      return new PdfjsDocHandle(doc, task, sizes);
    },
  };
}
