// The one interface the UI is allowed to talk to (CLAUDE.md §4).
// Adapters (pdfium, pdfjs) implement it; the Phase 0 spike picks the primary — ADR 0002.

export interface PdfEngine {
  open(bytes: ArrayBuffer, opts?: { password?: string }): Promise<DocHandle>;
}

/** One entry of the document's outline (its bookmarks). */
export interface OutlineItem {
  title: string;
  /** Source page index, or undefined when the bookmark points elsewhere. */
  page?: number | undefined;
  children: OutlineItem[];
}

export interface DocHandle {
  pageCount(): number;
  /** In PDF points, with page rotation applied. */
  pageSize(index: number): { width: number; height: number };
  renderPage(index: number, scale: number): Promise<ImageBitmap>;
  extractText(index: number): Promise<TextRun[]>;
  /** The document's bookmarks, empty when it has none. */
  outline(): Promise<OutlineItem[]>;
  /**
   * True when the file carries an /Encrypt dictionary even though it opened
   * without a password — which is what a document locked only against changes
   * looks like. Callers need it because pdf-lib cannot read an encrypted file
   * at all, so such a document renders perfectly and then refuses every edit.
   *
   * Optional: only an adapter that can read the security handler answers. One
   * that cannot leaves it out rather than claiming the file is not encrypted.
   */
  isEncrypted?(): boolean;
  close(): void;
}

/**
 * A run of text with its box in PDF points, origin at the page's bottom-left.
 *
 * ponytail: pdf.js reports a baseline origin, PDFium a glyph bounding box, so
 * `y` differs by up to the font descent between adapters. Fine for search and
 * selection hit-testing; if redaction (Phase 2) needs exact boxes, derive them
 * from the engine's own glyph quads instead of this type.
 */
export interface TextRun {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Optional per-phase timings, used by the engine benchmark (scripts/bench-engines.mjs). */
export type TimingSink = (phase: "parse" | "pageSizes", ms: number) => void;

/** Thrown when a document needs a password, so the UI can prompt instead of failing. */
export class PasswordRequiredError extends Error {
  constructor(message = "This document is password protected") {
    super(message);
    this.name = "PasswordRequiredError";
  }
}
