import { createWorker, type ImageLike, type Worker } from "tesseract.js";

/**
 * Tesseract OCR, with every asset served from our own origin.
 *
 * tesseract.js defaults its worker script, wasm core and language data to
 * jsDelivr; loading any of them would break privacy invariants 2 and 3
 * (CLAUDE.md §1), so all four paths are required options with no defaults. The
 * caller passes URLs produced by the bundler, exactly as the PDFium and qpdf
 * wrappers do.
 *
 * Language data is 1–5 MB per language (10 MB for eng + mal + hin), too much to
 * bundle for everyone, so it is an opt-in one-time download from our own host —
 * the only form docs/PRIVACY.md allows.
 */
export interface OcrAssets {
  /** URL of the bundled tesseract.js worker script. */
  workerPath: string;
  /** Directory URL of the bundled tesseract.js-core wasm. */
  corePath: string;
  /** Directory URL holding `<lang>.traineddata`. */
  langPath: string;
}

export interface OcrOptions extends OcrAssets {
  /** Tesseract language codes, e.g. ["mal", "eng"] for mixed Malayalam. */
  languages: string[];
  /**
   * Where to keep downloaded language data. "none" re-downloads every run;
   * "write" keeps it in IndexedDB, which docs/PRIVACY.md permits for language
   * packs (never for documents). Defaults to "none" so nothing persists unless
   * the caller asks.
   */
  cache?: "none" | "write";
  onProgress?: ((status: string, progress: number) => void) | undefined;
}

export interface OcrWord {
  text: string;
  confidence: number;
  /** Pixel box in the image that was recognised. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrResult {
  text: string;
  /** 0–100, as Tesseract reports it. */
  confidence: number;
  words: OcrWord[];
}

export type OcrInput = ImageBitmap | Blob | OffscreenCanvas | Uint8Array;

export interface Ocr {
  recognise(image: OcrInput): Promise<OcrResult>;
  /**
   * The recognised page as a searchable PDF: the image with an invisible text
   * layer over it. Tesseract writes this itself using its own glyphless font,
   * which is why we do not have to embed a Malayalam or Devanagari font to make
   * Indic text searchable.
   */
  recogniseToPdf(image: OcrInput): Promise<Uint8Array>;
  terminate(): Promise<void>;
}

/**
 * tesseract.js takes canvases, blobs and buffers, but not an ImageBitmap — and
 * its type for raw bytes is Node's Buffer, while a browser hands us a
 * Uint8Array, which it accepts at runtime.
 */
function asImageLike(image: OcrInput): ImageLike {
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("could not get a 2D context");
    ctx.drawImage(image, 0, 0);
    return canvas;
  }
  return image as ImageLike;
}

function sameOriginOnly(urls: string[]): void {
  const location = globalThis.location;
  if (!location) return;
  for (const url of urls) {
    if (new URL(url, location.href).origin !== location.origin) {
      throw new Error(`OCR assets must be same-origin (got ${url}); see docs/PRIVACY.md`);
    }
  }
}

export async function createOcr(options: OcrOptions): Promise<Ocr> {
  if (options.languages.length === 0) throw new Error("at least one language is required");
  sameOriginOnly([options.workerPath, options.corePath, options.langPath]);

  const worker: Worker = await createWorker(options.languages, undefined, {
    workerPath: options.workerPath,
    corePath: options.corePath,
    langPath: options.langPath,
    cacheMethod: options.cache ?? "none",
    // The data is served from our own origin uncompressed; asking for gzip makes
    // tesseract.js look for `<lang>.traineddata.gz` instead.
    gzip: false,
    ...(options.onProgress
      ? { logger: (message) => options.onProgress?.(message.status, message.progress) }
      : {}),
  });

  return {
    async recognise(image) {
      // Word boxes live inside the block tree, which only comes back when asked
      // for; the flat `text` is always there.
      const { data } = await worker.recognize(asImageLike(image), {}, { text: true, blocks: true });
      const words: OcrWord[] = [];
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            for (const word of line.words) {
              words.push({ text: word.text, confidence: word.confidence, bbox: word.bbox });
            }
          }
        }
      }
      return { text: data.text, confidence: data.confidence, words };
    },

    async recogniseToPdf(image) {
      const { data } = await worker.recognize(asImageLike(image), {}, { pdf: true });
      if (!data.pdf) throw new Error("Tesseract produced no PDF output");
      return new Uint8Array(data.pdf);
    },
    async terminate() {
      await worker.terminate();
    },
  };
}
