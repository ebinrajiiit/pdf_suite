// Typed worker protocol. Every request carries an id so responses can be matched,
// progress reported and long operations cancelled (docs/ARCHITECTURE.md).
//
// The worker owns the document bytes: a 200 MB file is posted in once and never
// posted back, only derived results (page sizes, bitmaps, saved bytes) are.

export interface DocumentInfo {
  pageCount: number;
  /** PDF points, rotation applied. */
  pageSizes: { width: number; height: number }[];
}

export type WorkerRequest = { id: number } & (
  | { kind: "init"; wasmBinary: ArrayBuffer }
  | { kind: "open"; bytes: ArrayBuffer; password?: string }
  /** Appends the given documents to the open one and reopens the result. */
  | { kind: "merge"; inputs: ArrayBuffer[] }
  | { kind: "render"; page: number; scale: number }
  /** `order` is source page indices in their new positions; omitted pages are dropped. */
  | { kind: "save"; order: number[] }
  | { kind: "close" }
  | { kind: "cancel"; target: number }
);

export type WorkerResponse = { id: number } & (
  | { kind: "ready" }
  | { kind: "document"; info: DocumentInfo }
  | { kind: "bitmap"; bitmap: ImageBitmap }
  | { kind: "saved"; bytes: ArrayBuffer }
  | { kind: "closed" }
  | { kind: "progress"; done: number; total: number }
  | { kind: "cancelled" }
  | { kind: "error"; message: string; name: string }
);

/** Replies that complete a request; `progress` does not. */
export type TerminalResponse = Extract<
  WorkerResponse,
  { kind: "ready" | "document" | "bitmap" | "saved" | "closed" | "cancelled" | "error" }
>;

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}
