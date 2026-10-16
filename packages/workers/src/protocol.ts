// Typed worker protocol. Every request carries an id so responses can be matched,
// progress reported and long operations cancelled (docs/ARCHITECTURE.md).
//
// The worker owns the document bytes: a 200 MB file is posted in once and never
// posted back, only derived results (page sizes, bitmaps, saved bytes) are.

import type { Annotation } from "@pdf-suite/core";
import type { TextRun } from "@pdf-suite/engine";
/**
 * `order` on a request is source page indices in their display positions, with
 * omitted pages deleted. Every request that rewrites bytes applies it first, so
 * a deletion cannot come back to life when the document is next rewritten.
 */
export interface DocumentInfo {
  pageCount: number;
  /** PDF points, rotation applied. */
  pageSizes: { width: number; height: number }[];
  /** Set when the file was damaged and qpdf reconstructed it to open it. */
  repaired?: boolean;
  /** Set when the document arrived encrypted and will be re-protected on save. */
  protected?: boolean;
}

/**
 * Pending annotations travel with every request that rewrites bytes, like
 * `order` does, and are applied *before* the order is materialised: they are
 * keyed by source page index, which reordering would otherwise invalidate.
 */
export type { Annotation, AnnotRect } from "@pdf-suite/core";
export type { TextRun } from "@pdf-suite/engine";

/** One search hit, in the display position the user is looking at. */
export interface SearchHit {
  /** Display position, not the source page index. */
  position: number;
  /** Source page index, for rendering. */
  page: number;
  snippet: string;
  /** Boxes to highlight, in PDF points with the origin at the page bottom-left. */
  rects: { x: number; y: number; w: number; h: number }[];
}

export type WorkerRequest = { id: number } &
  /** `qpdfWasmUrl` must be same-origin; qpdf is only loaded when first needed. */
  (
    | { kind: "init"; wasmBinary: ArrayBuffer; qpdfWasmUrl: string }
    | { kind: "open"; bytes: ArrayBuffer }
    /**
     * Supplies the password for a document whose open() raised
     * PasswordRequiredError. The worker still holds those bytes, so they are not
     * sent again — open() transferred them, which detaches the sender's copy.
     */
    | { kind: "unlock"; password: string }
    /**
     * Appends the given documents to the open one and reopens the result. Where
     * the new pages appear is the caller's choice, made by setting the display
     * order afterwards.
     */
    | { kind: "merge"; inputs: ArrayBuffer[]; order: number[]; annotations: Annotation[] }
    | { kind: "render"; page: number; scale: number }
    /** Extracted text for one source page, used to snap highlights to lines. */
    | { kind: "text"; page: number }
    /** Rotates the given display positions by `by` degrees and reopens the result. */
    | {
        kind: "rotate";
        positions: number[];
        by: 90 | 180 | 270;
        order: number[];
        annotations: Annotation[];
      }
    /** Recompresses the document, reopening the result. */
    | { kind: "compress"; order: number[]; annotations: Annotation[] }
    /** Sets the password the document is saved with, or null to remove protection. */
    | { kind: "protect"; password: string | null }
    /**
     * Searches the pages in `order`, reporting progress per page. Long documents
     * are why the protocol has cancellation: a search over 500 pages extracts
     * text from every one of them.
     */
    | { kind: "search"; query: string; order: number[]; limit?: number }
    | { kind: "save"; order: number[]; annotations: Annotation[] }
    | { kind: "close" }
    | { kind: "cancel"; target: number }
  );

export type WorkerResponse = { id: number } & (
  | { kind: "ready" }
  | { kind: "document"; info: DocumentInfo }
  | { kind: "bitmap"; bitmap: ImageBitmap }
  | { kind: "saved"; bytes: ArrayBuffer }
  | { kind: "hits"; hits: SearchHit[]; truncated: boolean }
  | { kind: "runs"; runs: TextRun[] }
  | { kind: "closed" }
  | { kind: "progress"; done: number; total: number }
  | { kind: "cancelled" }
  | { kind: "error"; message: string; name: string }
);

/** Replies that complete a request; `progress` does not. */
export type TerminalResponse = Extract<
  WorkerResponse,
  {
    kind:
      | "ready"
      | "document"
      | "bitmap"
      | "saved"
      | "hits"
      | "runs"
      | "closed"
      | "cancelled"
      | "error";
  }
>;

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}
