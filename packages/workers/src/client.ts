import {
  CancelledError,
  type Annotation,
  type DocumentInfo,
  type FieldValues,
  type OcrAssets,
  type RedactArea,
  type RedactionResult,
  type SearchHit,
  type TextRun,
  type TerminalResponse,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.js";

/** Omit over a union has to distribute, or it collapses to the common keys only. */
type RequestBody = WorkerRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, "id">
    : never
  : never;

/** Progress callback for the operations that report it (currently merge). */
export type OnProgress = (done: number, total: number) => void;

export interface PdfWorkerClient {
  init(wasmBinary: ArrayBuffer, qpdfWasmUrl: string): Promise<void>;
  open(bytes: ArrayBuffer): Promise<DocumentInfo>;
  /** Retries a document that raised PasswordRequiredError, with its password. */
  unlock(password: string): Promise<DocumentInfo>;
  merge(
    inputs: ArrayBuffer[],
    order: number[],
    annotations: Annotation[],
    onProgress?: OnProgress,
  ): Promise<DocumentInfo>;
  render(page: number, scale: number): Promise<ImageBitmap>;
  /** Extracted text for one source page, for snapping highlights to lines. */
  pageText(page: number): Promise<TextRun[]>;
  rotate(
    positions: number[],
    by: 90 | 180 | 270,
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** Recompresses the document, which reopens it. */
  compress(order: number[], annotations: Annotation[]): Promise<DocumentInfo>;
  /** Writes form values, optionally flattening them, and reopens the document. */
  fillForm(
    values: FieldValues,
    flatten: boolean,
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /**
   * Removes the content inside the given areas. The reply says how many page
   * objects went and whether re-reading the result found any text left inside
   * them — a false `verified` must be shown to the user, not swallowed.
   */
  redact(
    areas: RedactArea[],
    order: number[],
    annotations: Annotation[],
  ): Promise<{
    info: DocumentInfo;
    removed: Record<number, number>;
    verified: boolean;
    leftovers: RedactionResult["leftovers"];
  }>;
  /** Sets the password applied when saving, or null to remove protection. */
  protect(password: string | null): Promise<DocumentInfo>;
  /** Searches the given display order, reporting progress per page. */
  search(
    query: string,
    order: number[],
    onProgress?: OnProgress,
  ): Promise<{ hits: SearchHit[]; truncated: boolean }>;
  save(order: number[], annotations: Annotation[]): Promise<ArrayBuffer>;
  /** Splits into parts starting at the given display positions. */
  split(at: number[], order: number[], annotations: Annotation[]): Promise<ArrayBuffer[]>;
  /** Builds a document from images and opens it. */
  fromImages(images: { bytes: ArrayBuffer; type: string }[]): Promise<DocumentInfo>;
  /**
   * Makes the given display positions searchable. Pages that already have text
   * are left alone and counted as skipped.
   */
  ocr(
    positions: number[],
    order: number[],
    annotations: Annotation[],
    languages: string[],
    assets: OcrAssets,
    despeckle: boolean,
    onProgress?: OnProgress,
  ): Promise<{ info: DocumentInfo; recognised: number; skipped: number }>;
  /** Renders the given display positions to PNG. */
  toImages(
    positions: number[],
    order: number[],
    scale: number,
    onProgress?: OnProgress,
  ): Promise<{ position: number; bytes: ArrayBuffer }[]>;
  close(): Promise<void>;
  /** Abandons the operation the returned handle identifies. */
  cancel(id: number): void;
  terminate(): void;
}

/**
 * The worker is addressed by URL rather than by import so bundlers emit it as a
 * worker chunk; it stays same-origin, which `worker-src 'self' blob:` requires.
 */
export function createPdfWorker(): Worker {
  // The .ts extension is deliberate: these packages are consumed as source, so
  // the bundler has to see the real file to emit it as a worker chunk.
  return new Worker(new URL("./pdf.worker.ts", import.meta.url), {
    type: "module",
    name: "pdf-suite",
  });
}

export function createPdfWorkerClient(worker: Worker = createPdfWorker()): PdfWorkerClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (r: TerminalResponse) => void; reject: (e: Error) => void; onProgress?: OnProgress }
  >();

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    if (response.kind === "progress") {
      entry.onProgress?.(response.done, response.total);
      return;
    }
    pending.delete(response.id);
    if (response.kind === "error") {
      const error = new Error(response.message);
      error.name = response.name;
      entry.reject(error);
    } else if (response.kind === "cancelled") {
      entry.reject(new CancelledError());
    } else {
      entry.resolve(response);
    }
  };

  worker.onerror = (event) => {
    const error = new Error(`worker failed: ${event.message}`);
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  };

  function send(
    request: RequestBody,
    transfer: Transferable[] = [],
    onProgress?: OnProgress,
  ): Promise<TerminalResponse> {
    const id = nextId++;
    return new Promise<TerminalResponse>((resolve, reject) => {
      pending.set(id, onProgress ? { resolve, reject, onProgress } : { resolve, reject });
      worker.postMessage({ ...request, id } as WorkerRequest, transfer);
    });
  }

  /** Narrows a reply to the kind the caller expects, so a stray kind is a clear error. */
  function expect<K extends TerminalResponse["kind"]>(
    response: TerminalResponse,
    kind: K,
  ): Extract<TerminalResponse, { kind: K }> {
    if (response.kind !== kind)
      throw new Error(`worker replied ${response.kind}, expected ${kind}`);
    return response as Extract<TerminalResponse, { kind: K }>;
  }

  return {
    async init(wasmBinary, qpdfWasmUrl) {
      expect(await send({ kind: "init", wasmBinary, qpdfWasmUrl }, [wasmBinary]), "ready");
    },
    async open(bytes) {
      return expect(await send({ kind: "open", bytes }, [bytes]), "document").info;
    },
    async unlock(password) {
      return expect(await send({ kind: "unlock", password }), "document").info;
    },
    async merge(inputs, order, annotations, onProgress) {
      return expect(
        await send({ kind: "merge", inputs, order, annotations }, inputs, onProgress),
        "document",
      ).info;
    },
    async render(page, scale) {
      return expect(await send({ kind: "render", page, scale }), "bitmap").bitmap;
    },
    async pageText(page) {
      return expect(await send({ kind: "text", page }), "runs").runs;
    },
    async rotate(positions, by, order, annotations) {
      return expect(await send({ kind: "rotate", positions, by, order, annotations }), "document")
        .info;
    },
    async compress(order, annotations) {
      return expect(await send({ kind: "compress", order, annotations }), "document").info;
    },
    async fillForm(values, flatten, order, annotations) {
      return expect(
        await send({ kind: "fillForm", values, flatten, order, annotations }),
        "document",
      ).info;
    },
    async redact(areas, order, annotations) {
      const reply = expect(await send({ kind: "redact", areas, order, annotations }), "redacted");
      return {
        info: reply.info,
        removed: reply.removed,
        verified: reply.verified,
        leftovers: reply.leftovers,
      };
    },
    async protect(password) {
      return expect(await send({ kind: "protect", password }), "document").info;
    },
    async search(query, order, onProgress) {
      const reply = expect(await send({ kind: "search", query, order }, [], onProgress), "hits");
      return { hits: reply.hits, truncated: reply.truncated };
    },
    async save(order, annotations) {
      return expect(await send({ kind: "save", order, annotations }), "saved").bytes;
    },
    async fromImages(images) {
      return expect(
        await send(
          { kind: "fromImages", images },
          images.map((image) => image.bytes),
        ),
        "document",
      ).info;
    },
    async ocr(positions, order, annotations, languages, assets, despeckle, onProgress) {
      const reply = expect(
        await send(
          { kind: "ocr", positions, order, annotations, languages, assets, despeckle },
          [],
          onProgress,
        ),
        "ocrDone",
      );
      return { info: reply.info, recognised: reply.recognised, skipped: reply.skipped };
    },
    async toImages(positions, order, scale, onProgress) {
      return expect(
        await send({ kind: "toImages", positions, order, scale }, [], onProgress),
        "images",
      ).images;
    },
    async split(at, order, annotations) {
      return expect(await send({ kind: "split", at, order, annotations }), "parts").parts;
    },
    async close() {
      expect(await send({ kind: "close" }), "closed");
    },
    cancel(id) {
      worker.postMessage({ kind: "cancel", target: id, id: nextId++ } satisfies WorkerRequest);
    },
    terminate() {
      worker.terminate();
      pending.clear();
    },
  };
}
