/// <reference lib="webworker" />
import {
  annotate,
  createQpdf,
  merge,
  reorder,
  rotate,
  split,
  type Annotation,
  type Qpdf,
} from "@pdf-suite/core";
import {
  findMatches,
  PasswordRequiredError,
  type DocHandle,
  type PdfEngine,
} from "@pdf-suite/engine";
import { createPdfiumEngine } from "@pdf-suite/engine/pdfium";
import {
  CancelledError,
  type DocumentInfo,
  type SearchHit,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.js";

// All parsing and rasterising happens here so the main thread never blocks
// (CLAUDE.md §4). The engine wasm is handed in by the app from its own bundle;
// qpdf's is fetched from a same-origin URL on first use, because most documents
// never need it and it is another 1.2 MB.

let engine: PdfEngine | undefined;
let doc: DocHandle | undefined;
/** The open document's bytes, decrypted and ready for pdf-lib. */
let bytes: Uint8Array | undefined;
/**
 * The password the document arrived with. Editing needs decrypted bytes (pdf-lib
 * cannot read an encrypted file), so saving re-applies protection — otherwise
 * opening a protected document and saving it would quietly strip its password.
 */
let protection: string | null = null;
let repaired = false;
/** Bytes of a document that needs a password, held until one arrives. */
let locked: Uint8Array | undefined;
const cancelled = new Set<number>();

let qpdfWasmUrl: string | undefined;
let qpdfInstance: Promise<Qpdf> | undefined;

function qpdf(): Promise<Qpdf> {
  if (!qpdfWasmUrl) throw new Error("worker not initialised");
  qpdfInstance ??= createQpdf({ wasmUrl: qpdfWasmUrl });
  return qpdfInstance;
}

async function info(handle: DocHandle): Promise<DocumentInfo> {
  const pageCount = handle.pageCount();
  const pageSizes = [];
  for (let i = 0; i < pageCount; i++) pageSizes.push(handle.pageSize(i));
  // The outline is read once per open: it is small, and the panel needs it
  // immediately rather than after another round trip.
  const outline = await handle.outline().catch(() => []);
  return { pageCount, pageSizes, outline, repaired, protected: protection !== null };
}

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function throwIfCancelled(id: number): void {
  if (cancelled.has(id)) throw new CancelledError();
}

async function openBytes(id: number, next: Uint8Array): Promise<DocumentInfo> {
  if (!engine) throw new Error("worker not initialised");
  doc?.close();
  doc = undefined;
  // Hand over the whole buffer rather than a slice: the engine copies what it
  // needs internally, and a 200 MB document must not be copied twice here.
  const buffer = next.buffer as ArrayBuffer;
  const handle = await engine.open(buffer);
  throwIfCancelled(id);
  doc = handle;
  bytes = next;
  return info(handle);
}

/**
 * Opens a file the user chose, which may be encrypted, damaged, or both.
 *
 * A damaged one gets a qpdf repair pass and one retry (CLAUDE.md §4 — malformed
 * PDFs are normal). An encrypted one is held for `unlock`, because every
 * structural op goes through pdf-lib, which cannot read encrypted files at all,
 * so the password is needed to decrypt rather than just to view.
 */
async function openChosen(id: number, input: Uint8Array): Promise<DocumentInfo> {
  repaired = false;
  protection = null;
  locked = undefined;

  try {
    return await openBytes(id, input);
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    if (err instanceof PasswordRequiredError) {
      locked = input;
      throw err;
    }

    const reconstructed = await (await qpdf()).repair(input);
    throwIfCancelled(id);
    repaired = true;
    return openBytes(id, reconstructed);
  }
}

/** Decrypts the held document and opens it, keeping its password for saving. */
async function unlock(id: number, password: string): Promise<DocumentInfo> {
  if (!locked) throw new Error("no document is waiting for a password");
  // A wrong password throws, and `locked` is kept so the user can try again.
  const decrypted = await (await qpdf()).decrypt(locked, password);
  throwIfCancelled(id);
  protection = password;
  locked = undefined;
  return openBytes(id, decrypted);
}

/**
 * The open document with everything the user has done applied: pending
 * annotations written in, pages in their shown positions, deletions gone. Every
 * structural op starts here, so rewriting bytes can never resurrect a page the
 * user deleted.
 *
 * Annotations go in first, while page indices still mean what they did when the
 * user placed them; reordering afterwards carries them along with their pages.
 */
async function materialise(
  id: number,
  order: number[],
  annotations: Annotation[] = [],
): Promise<Uint8Array> {
  if (!bytes) throw new Error("no document is open");
  const marked = annotations.length === 0 ? bytes : await annotate(bytes, annotations);
  throwIfCancelled(id);
  const identity = order.length === doc?.pageCount() && order.every((page, i) => page === i);
  if (identity) return marked;
  const applied = await reorder(marked, order);
  throwIfCancelled(id);
  return applied;
}

async function handle(request: WorkerRequest): Promise<void> {
  const { id } = request;
  switch (request.kind) {
    case "init": {
      engine = await createPdfiumEngine({ wasmBinary: request.wasmBinary });
      qpdfWasmUrl = request.qpdfWasmUrl;
      post({ id, kind: "ready" });
      return;
    }
    case "open": {
      post({ id, kind: "document", info: await openChosen(id, new Uint8Array(request.bytes)) });
      return;
    }
    case "unlock": {
      post({ id, kind: "document", info: await unlock(id, request.password) });
      return;
    }
    case "merge": {
      const inputs = [
        await materialise(id, request.order, request.annotations),
        ...request.inputs.map((b) => new Uint8Array(b)),
      ];
      post({ id, kind: "progress", done: 0, total: inputs.length });
      throwIfCancelled(id);
      const merged = await merge(inputs);
      post({ id, kind: "progress", done: inputs.length, total: inputs.length });
      throwIfCancelled(id);
      post({ id, kind: "document", info: await openBytes(id, merged) });
      return;
    }
    case "render": {
      if (!doc) throw new Error("no document is open");
      const bitmap = await doc.renderPage(request.page, request.scale);
      if (cancelled.has(id)) {
        // Nothing is waiting for it; releasing beats leaking a bitmap.
        bitmap.close();
        throw new CancelledError();
      }
      post({ id, kind: "bitmap", bitmap }, [bitmap]);
      return;
    }
    case "text": {
      if (!doc) throw new Error("no document is open");
      const runs = await doc.extractText(request.page);
      post({ id, kind: "runs", runs });
      return;
    }
    case "rotate": {
      const base = await materialise(id, request.order, request.annotations);
      const rotated = await rotate(base, request.positions, request.by);
      throwIfCancelled(id);
      post({ id, kind: "document", info: await openBytes(id, rotated) });
      return;
    }
    case "compress": {
      const base = await materialise(id, request.order, request.annotations);
      const smaller = await (await qpdf()).compress(base);
      throwIfCancelled(id);
      post({ id, kind: "document", info: await openBytes(id, smaller) });
      return;
    }
    case "protect": {
      if (!bytes) throw new Error("no document is open");
      // Protection is applied on save, not now: the working copy has to stay
      // readable by pdf-lib for every other operation.
      protection = request.password;
      if (!doc) throw new Error("no document is open");
      post({ id, kind: "document", info: await info(doc) });
      return;
    }
    case "search": {
      if (!doc) throw new Error("no document is open");
      const limit = request.limit ?? 500;
      const hits: SearchHit[] = [];
      let truncated = false;

      for (const [position, page] of request.order.entries()) {
        throwIfCancelled(id);
        // Text extraction is the expensive part, so progress is per page and a
        // cancel between pages abandons the rest.
        const runs = await doc.extractText(page);
        for (const match of findMatches(runs, request.query)) {
          if (hits.length >= limit) {
            truncated = true;
            break;
          }
          hits.push({ position, page, snippet: match.snippet, rects: match.rects });
        }
        post({ id, kind: "progress", done: position + 1, total: request.order.length });
        if (truncated) break;
      }

      post({ id, kind: "hits", hits, truncated });
      return;
    }
    case "split": {
      const base = await materialise(id, request.order, request.annotations);
      // Boundaries are where a new part starts; 0 is implied and duplicates and
      // out-of-range values are ignored rather than producing empty parts.
      const count = request.order.length;
      const starts = [...new Set([0, ...request.at.filter((n) => n > 0 && n < count)])].sort(
        (a, b) => a - b,
      );
      const ranges: [number, number][] = starts.map((start, i) => [
        start,
        (starts[i + 1] ?? count) - 1,
      ]);
      const parts = (await split(base, ranges)).map((bytes) => bytes.buffer as ArrayBuffer);
      throwIfCancelled(id);
      post({ id, kind: "parts", parts }, parts);
      return;
    }
    case "save": {
      const materialised = await materialise(id, request.order, request.annotations);
      throwIfCancelled(id);
      const out =
        protection === null
          ? materialised
          : await (await qpdf()).encrypt(materialised, { userPassword: protection });
      throwIfCancelled(id);
      // An op's output is ours to give away; the open document's own bytes have
      // to be copied, because transferring would detach them.
      const buffer = (out === bytes ? out.slice() : out).buffer as ArrayBuffer;
      post({ id, kind: "saved", bytes: buffer }, [buffer]);
      return;
    }
    case "close": {
      doc?.close();
      doc = undefined;
      bytes = undefined;
      protection = null;
      repaired = false;
      locked = undefined;
      post({ id, kind: "closed" });
      return;
    }
  }
}

// Requests are processed one at a time: messages arrive faster than they are
// served, and an `open` racing ahead of `init` would find no engine. Cancels skip
// the queue, since the point of a cancel is to reach a running operation.
let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.kind === "cancel") {
    cancelled.add(request.target);
    post({ id: request.id, kind: "closed" });
    return;
  }
  queue = queue.then(() => serve(request));
};

function serve(request: WorkerRequest): Promise<void> {
  return handle(request)
    .catch((err: unknown) => {
      if (err instanceof CancelledError) {
        post({ id: request.id, kind: "cancelled" });
        return;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      post({ id: request.id, kind: "error", message: error.message, name: error.name });
    })
    .finally(() => cancelled.delete(request.id));
}
