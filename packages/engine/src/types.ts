// The one interface the UI is allowed to talk to (CLAUDE.md §4).
// Adapters (pdfium, pdfjs) implement it; the Phase 0 spike picks the primary — ADR 0002.

export interface PdfEngine {
  open(bytes: ArrayBuffer, opts?: { password?: string }): Promise<DocHandle>;
}

export interface DocHandle {
  pageCount(): number;
  /** In PDF points. */
  pageSize(index: number): { width: number; height: number };
  renderPage(index: number, scale: number): Promise<ImageBitmap>;
  extractText(index: number): Promise<TextRun[]>;
  close(): void;
}

export interface TextRun {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
