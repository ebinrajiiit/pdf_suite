/// <reference lib="webworker" />
import { merge, reorder, rotate } from "@pdf-suite/core";
import type { DocHandle, PdfEngine } from "@pdf-suite/engine";
import { createPdfiumEngine } from "@pdf-suite/engine/pdfium";
import {
  CancelledError,
  type DocumentInfo,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.js";

// All parsing and rasterising happens here so the main thread never blocks
// (CLAUDE.md §4). The wasm binary is handed in by the app from its own bundle —
// this worker never fetches anything.

let engine: PdfEngine | undefined;
let doc: DocHandle | undefined;
/** The open document's bytes, kept for merge and save. */
let bytes: Uint8Array | undefined;
const cancelled = new Set<number>();

function info(handle: DocHandle): DocumentInfo {
  const pageCount = handle.pageCount();
  const pageSizes = [];
  for (let i = 0; i < pageCount; i++) pageSizes.push(handle.pageSize(i));
  return { pageCount, pageSizes };
}

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function throwIfCancelled(id: number): void {
  if (cancelled.has(id)) throw new CancelledError();
}

async function openBytes(id: number, next: Uint8Array, password?: string): Promise<DocumentInfo> {
  if (!engine) throw new Error("worker not initialised");
  doc?.close();
  doc = undefined;
  // Hand over the whole buffer rather than a slice: the engine copies what it
  // needs internally, and a 200 MB document must not be copied twice here.
  const buffer = next.buffer as ArrayBuffer;
  const handle = await engine.open(buffer, password === undefined ? undefined : { password });
  throwIfCancelled(id);
  doc = handle;
  bytes = next;
  return info(handle);
}

/**
 * The open document with the display order applied: pages in their shown
 * positions, deletions gone. Every structural op starts here, so rewriting bytes
 * can never resurrect a page the user deleted.
 */
async function materialise(id: number, order: number[]): Promise<Uint8Array> {
  if (!bytes) throw new Error("no document is open");
  if (order.length === doc?.pageCount() && order.every((page, i) => page === i)) return bytes;
  const applied = await reorder(bytes, order);
  throwIfCancelled(id);
  return applied;
}

async function handle(request: WorkerRequest): Promise<void> {
  const { id } = request;
  switch (request.kind) {
    case "init": {
      engine = await createPdfiumEngine({ wasmBinary: request.wasmBinary });
      post({ id, kind: "ready" });
      return;
    }
    case "open": {
      const next = new Uint8Array(request.bytes);
      post({ id, kind: "document", info: await openBytes(id, next, request.password) });
      return;
    }
    case "merge": {
      const inputs = [
        await materialise(id, request.order),
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
    case "rotate": {
      const base = await materialise(id, request.order);
      const rotated = await rotate(base, request.positions, request.by);
      throwIfCancelled(id);
      post({ id, kind: "document", info: await openBytes(id, rotated) });
      return;
    }
    case "save": {
      const out = await materialise(id, request.order);
      throwIfCancelled(id);
      // A materialised copy is ours to give away; the open document's own bytes
      // have to be copied, because transferring would detach them.
      const buffer = (out === bytes ? out.slice() : out).buffer as ArrayBuffer;
      post({ id, kind: "saved", bytes: buffer }, [buffer]);
      return;
    }
    case "close": {
      doc?.close();
      doc = undefined;
      bytes = undefined;
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
