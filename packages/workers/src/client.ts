import {
  CancelledError,
  type DocumentInfo,
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
  init(wasmBinary: ArrayBuffer): Promise<void>;
  open(bytes: ArrayBuffer, password?: string): Promise<DocumentInfo>;
  merge(inputs: ArrayBuffer[], order: number[], onProgress?: OnProgress): Promise<DocumentInfo>;
  render(page: number, scale: number): Promise<ImageBitmap>;
  rotate(positions: number[], by: 90 | 180 | 270, order: number[]): Promise<DocumentInfo>;
  save(order: number[]): Promise<ArrayBuffer>;
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
    async init(wasmBinary) {
      expect(await send({ kind: "init", wasmBinary }, [wasmBinary]), "ready");
    },
    async open(bytes, password) {
      const request: RequestBody =
        password === undefined ? { kind: "open", bytes } : { kind: "open", bytes, password };
      return expect(await send(request, [bytes]), "document").info;
    },
    async merge(inputs, order, onProgress) {
      return expect(await send({ kind: "merge", inputs, order }, inputs, onProgress), "document")
        .info;
    },
    async render(page, scale) {
      return expect(await send({ kind: "render", page, scale }), "bitmap").bitmap;
    },
    async rotate(positions, by, order) {
      return expect(await send({ kind: "rotate", positions, by, order }), "document").info;
    },
    async save(order) {
      return expect(await send({ kind: "save", order }), "saved").bytes;
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
