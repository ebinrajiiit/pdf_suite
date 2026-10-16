// The one interface the UI is allowed to talk to (CLAUDE.md §4).
// Adapters (pdfium, pdfjs) implement it; the Phase 0 spike picks the primary — ADR 0002.

export interface PdfEngine {
  open(bytes: ArrayBuffer, opts?: { password?: string }): Promise<DocHandle>;
}

export interface DocHandle {
  pageCount(): number;
  /** In PDF points, with page rotation applied. */
  pageSize(index: number): { width: number; height: number };
  renderPage(index: number, scale: number): Promise<ImageBitmap>;
  extractText(index: number): Promise<TextRun[]>;
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
