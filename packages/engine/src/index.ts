// The interface and nothing else. Adapters are reached by subpath
// (`@pdf-suite/engine/pdfium`, `@pdf-suite/engine/pdfjs`) so that importing the
// interface cannot drag an engine into the bundle: re-exporting both from here
// put ~800 KB of unused pdf.js into the worker chunk. ADR 0002 ships one engine.
export type { DocHandle, OutlineItem, PdfEngine, TextRun, TimingSink } from "./types.js";
export { PasswordRequiredError } from "./types.js";
export { findMatches } from "./search.js";
export type { SearchMatch, SearchRect } from "./search.js";
