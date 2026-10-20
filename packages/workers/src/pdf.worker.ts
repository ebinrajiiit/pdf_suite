/// <reference lib="webworker" />
import {
  annotate,
  createQpdf,
  fillForm,
  readForm,
  merge,
  reorder,
  imagesToPdf,
  findHidden,
  readProperties,
  setOutline,
  rotate,
  sanitise,
  setProperties,
  split,
  stampPages,
  type Annotation,
  type Qpdf,
} from "@pdf-suite/core";
import { findMatches, PasswordRequiredError, type DocHandle } from "@pdf-suite/engine";
import { createPdfiumEngine, type PdfiumEngine } from "@pdf-suite/engine/pdfium";
import { createOcr } from "@pdf-suite/ocr";
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

let engine: PdfiumEngine | undefined;
let doc: DocHandle | undefined;
/** The open document's bytes, decrypted and ready for pdf-lib. */
let bytes: Uint8Array | undefined;
/**
 * The password the document arrived with. Editing needs decrypted bytes (pdf-lib
 * cannot read an encrypted file), so saving re-applies protection — otherwise
 * opening a protected document and saving it would quietly strip its password.
 */
let protection: string | null = null;
/**
 * Undo history. The worker already holds every version of the document, so this
 * is where undo costs least: a step is the bytes as they were before an
 * operation, plus the page order and the unsaved annotations that went with
 * them, so undoing puts the whole document back rather than only its bytes.
 *
 * Bounded, because a step of a 200 MB scan costs 200 MB (CLAUDE.md §4 — big
 * files are normal). The oldest steps go first, and one step is always kept, so
 * a single undo works whatever the document's size.
 */
interface Step {
  bytes: Uint8Array;
  order: number[];
  annotations: Annotation[];
}
let past: Step[] = [];
let future: Step[] = [];
const HISTORY_STEPS = 20;
const HISTORY_BYTES = 256 * 1024 * 1024;

function trimHistory(): void {
  let total = past.reduce((sum, step) => sum + step.bytes.byteLength, 0);
  while (past.length > 1 && (past.length > HISTORY_STEPS || total > HISTORY_BYTES)) {
    total -= past.shift()!.bytes.byteLength;
  }
}
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

async function info(handle: DocHandle, bytesForForm?: Uint8Array): Promise<DocumentInfo> {
  const pageCount = handle.pageCount();
  const pageSizes = [];
  for (let i = 0; i < pageCount; i++) pageSizes.push(handle.pageSize(i));
  // The outline is read once per open: it is small, and the panel needs it
  // immediately rather than after another round trip.
  const outline = await handle.outline().catch(() => []);
  // Form fields come from the bytes rather than the engine, and a document
  // without a form reads as an empty field list rather than an error.
  const form = bytesForForm
    ? await readForm(bytesForForm).catch(() => ({ fields: [], hasXfa: false }))
    : { fields: [], hasXfa: false };
  const properties = bytesForForm
    ? await readProperties(bytesForForm).catch(() => blankProperties())
    : blankProperties();
  return {
    pageCount,
    pageSizes,
    outline,
    form,
    repaired,
    protected: protection !== null,
    properties,
    undo: past.length,
    redo: future.length,
  };
}

/** A document that could not be read for its description still has one. */
function blankProperties() {
  return { title: "", author: "", subject: "", keywords: "" };
}

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function throwIfCancelled(id: number): void {
  if (cancelled.has(id)) throw new CancelledError();
}

/**
 * Replaces the open document. `from` is the request that caused the change: its
 * page order and annotations are what the document looked like beforehand, so
 * passing it is what makes the change undoable. Opening a file passes nothing
 * and starts a fresh history instead.
 */
async function openBytes(
  id: number,
  next: Uint8Array,
  from?: { order: number[]; annotations: Annotation[] },
): Promise<DocumentInfo> {
  if (!engine) throw new Error("worker not initialised");
  if (from && bytes) {
    past.push({ bytes, order: from.order, annotations: from.annotations });
    trimHistory();
    // A new change is a new branch: what was undone cannot be redone after it.
    future = [];
  }
  doc?.close();
  doc = undefined;
  // Hand over the whole buffer rather than a slice: the engine copies what it
  // needs internally, and a 200 MB document must not be copied twice here.
  const buffer = next.buffer as ArrayBuffer;
  const handle = await engine.open(buffer);
  throwIfCancelled(id);
  doc = handle;
  bytes = next;
  return info(handle, next);
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
  // Another document is not another step in this one's history.
  past = [];
  future = [];

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

/** One page of a document as its own single-page document. */
async function splitOne(bytes: Uint8Array, index: number): Promise<Uint8Array> {
  const [only] = await split(bytes, [[index, index]]);
  if (!only) throw new Error(`could not take page ${index}`);
  return only;
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
      post({ id, kind: "document", info: await openBytes(id, merged, request) });
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
      post({ id, kind: "document", info: await openBytes(id, rotated, request) });
      return;
    }
    case "setProperties": {
      const base = await materialise(id, request.order, request.annotations);
      const described = await setProperties(base, request.properties);
      throwIfCancelled(id);
      post({ id, kind: "document", info: await openBytes(id, described, request) });
      return;
    }
    case "stamp": {
      const base = await materialise(id, request.order, request.annotations);
      // The stamp is applied after the display order, so "page 1" is the page
      // the reader sees first rather than the first page of the original file.
      const stamped = await stampPages(base, request.options);
      throwIfCancelled(id);
      post({ id, kind: "document", info: await openBytes(id, stamped, request) });
      return;
    }
    case "compress": {
      const base = await materialise(id, request.order, request.annotations);
      const smaller = await (await qpdf()).compress(base);
      throwIfCancelled(id);
      post({ id, kind: "document", info: await openBytes(id, smaller, request) });
      return;
    }
    case "protect": {
      if (!bytes) throw new Error("no document is open");
      // Protection is applied on save, not now: the working copy has to stay
      // readable by pdf-lib for every other operation.
      protection = request.password;
      if (!doc) throw new Error("no document is open");
      post({ id, kind: "document", info: await info(doc, bytes) });
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
    case "fromImages": {
      const built = await imagesToPdf(
        request.images.map((image) => ({ bytes: new Uint8Array(image.bytes), type: image.type })),
      );
      throwIfCancelled(id);
      // A document built from images has no protection and no prior annotations.
      protection = null;
      repaired = false;
      post({ id, kind: "document", info: await openBytes(id, built) });
      return;
    }
    case "toImages": {
      if (!doc) throw new Error("no document is open");
      const images: { position: number; bytes: ArrayBuffer }[] = [];
      const transfer: Transferable[] = [];
      for (const position of request.positions) {
        throwIfCancelled(id);
        const page = request.order[position];
        if (page === undefined) continue;
        const bitmap = await doc.renderPage(page, request.scale);
        try {
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("could not get a 2D context");
          ctx.drawImage(bitmap, 0, 0);
          const blob = await canvas.convertToBlob({ type: "image/png" });
          const bytes = await blob.arrayBuffer();
          images.push({ position, bytes });
          transfer.push(bytes);
        } finally {
          bitmap.close();
        }
        post({ id, kind: "progress", done: images.length, total: request.positions.length });
      }
      post({ id, kind: "images", images }, transfer);
      return;
    }
    case "ocr": {
      if (!doc) throw new Error("no document is open");
      const base = await materialise(id, request.order, request.annotations);
      throwIfCancelled(id);

      const ocr = await createOcr({
        ...request.assets,
        languages: request.languages,
        // Language data is big; keeping it lets a second run start immediately
        // and makes OCR work offline. docs/PRIVACY.md allows this for language
        // packs, never for documents.
        cache: "write",
        despeckle: request.despeckle ?? false,
      });
      try {
        // 72 points to the inch, so this is the usual 300 dpi floor.
        const scale = (request.dpi ?? 300) / 72;
        const wanted = new Set(request.positions);
        const pages: Uint8Array[] = [];
        let recognised = 0;
        let skipped = 0;

        for (const [position, page] of request.order.entries()) {
          throwIfCancelled(id);
          // Each page becomes its own document, then they are merged back. For a
          // 500-page scan that is 500 merges — acceptable for now, but the
          // obvious thing to optimise if batch OCR gets slow.
          const single = await splitOne(base, position);

          if (!wanted.has(position)) {
            pages.push(single);
            continue;
          }
          // A page that already has text is left alone: re-OCRing it would
          // replace real text with a picture of it.
          const existing = await doc.extractText(page);
          if (existing.some((run) => run.text.trim() !== "")) {
            pages.push(single);
            skipped++;
            post({ id, kind: "progress", done: position + 1, total: request.order.length });
            continue;
          }

          const bitmap = await doc.renderPage(page, scale);
          try {
            pages.push(await ocr.recogniseToPdf(bitmap));
            recognised++;
          } finally {
            bitmap.close();
          }
          post({ id, kind: "progress", done: position + 1, total: request.order.length });
        }

        const merged = pages.length === 1 ? pages[0]! : await merge(pages);
        throwIfCancelled(id);
        post({
          id,
          kind: "ocrDone",
          info: await openBytes(id, merged, request),
          recognised,
          skipped,
        });
      } finally {
        await ocr.terminate();
      }
      return;
    }
    case "fillForm": {
      const base = await materialise(id, request.order, request.annotations);
      const filled = await fillForm(base, request.values, { flatten: request.flatten });
      throwIfCancelled(id);
      post({ id, kind: "document", info: await openBytes(id, filled, request) });
      return;
    }
    case "images": {
      if (!engine) throw new Error("worker not initialised");
      const base = await materialise(id, request.order, request.annotations);
      post({ id, kind: "pageImages", images: await engine.images(base, request.page) });
      return;
    }
    case "editImages": {
      if (!engine) throw new Error("worker not initialised");
      const base = await materialise(id, request.order, request.annotations);
      const result = await engine.editImages(base, request.edits);
      throwIfCancelled(id);
      post({
        id,
        kind: "imagesEdited",
        info: await openBytes(id, result.bytes, request),
        applied: result.applied,
        rejected: result.rejected,
      });
      return;
    }
    case "editableText": {
      if (!engine) throw new Error("worker not initialised");
      // Read from the document as it will be written, so run indices line up
      // with what an edit will address.
      const base = await materialise(id, request.order, request.annotations);
      post({ id, kind: "editable", runs: await engine.editableText(base, request.page) });
      return;
    }
    case "editText": {
      if (!engine) throw new Error("worker not initialised");
      const base = await materialise(id, request.order, request.annotations);
      const result = await engine.editText(base, request.edits);
      throwIfCancelled(id);
      post({
        id,
        kind: "edited",
        info: await openBytes(id, result.bytes, request),
        applied: result.applied,
        substituted: result.substituted,
        addedLines: result.addedLines,
        rejected: result.rejected,
      });
      return;
    }
    case "setOutline": {
      const base = await materialise(id, request.order, request.annotations);
      // Bookmark pages are display positions, like everything else the UI
      // sends, and materialising has just made those the document's own.
      const marked = await setOutline(base, request.bookmarks);
      throwIfCancelled(id);
      post({ id, kind: "document", info: await openBytes(id, marked, request) });
      return;
    }
    case "findHidden": {
      const base = await materialise(id, request.order, request.annotations);
      post({ id, kind: "hidden", report: await findHidden(base) });
      return;
    }
    case "sanitise": {
      const base = await materialise(id, request.order, request.annotations);
      const result = await sanitise(base, request.options);
      throwIfCancelled(id);
      post({
        id,
        kind: "sanitised",
        info: await openBytes(id, result.bytes, request),
        removed: result.removed,
        wasClean: result.wasClean,
      });
      return;
    }
    case "findPattern": {
      if (!engine) throw new Error("worker not initialised");
      // Searched as the document will be written, so the page numbers in the
      // result are the ones a redaction will act on.
      const base = await materialise(id, request.order, request.annotations);
      post({ id, kind: "found", found: await engine.findPattern(base, request.request) });
      return;
    }
    case "redact": {
      if (!engine) throw new Error("worker not initialised");
      const base = await materialise(id, request.order, request.annotations);
      // Areas are keyed by source page, like annotations, so they are applied to
      // the materialised document where those indices still hold.
      const result = await engine.redact(base, request.areas);
      throwIfCancelled(id);
      post({
        id,
        kind: "redacted",
        info: await openBytes(id, result.bytes, request),
        removed: result.removed,
        verified: result.verified,
        leftovers: result.leftovers,
      });
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
    case "undo":
    case "redo": {
      const from = request.kind === "undo" ? past : future;
      const onto = request.kind === "undo" ? future : past;
      const step = from.pop();
      if (!step || !bytes) throw new Error(`there is nothing to ${request.kind}`);
      // Where we are now becomes the step in the other direction, so undo and
      // redo walk the same history rather than two drifting copies of it.
      onto.push({ bytes, order: request.order, annotations: request.annotations });
      post({
        id,
        kind: "restored",
        info: await openBytes(id, step.bytes),
        order: step.order,
        annotations: step.annotations,
      });
      return;
    }
    case "close": {
      doc?.close();
      doc = undefined;
      bytes = undefined;
      protection = null;
      repaired = false;
      locked = undefined;
      past = [];
      future = [];
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
