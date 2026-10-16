export type { DocHandle, PdfEngine, TextRun, TimingSink } from "./types.js";
export { PasswordRequiredError } from "./types.js";
export { createPdfjsEngine, type PdfjsEngineOptions } from "./pdfjs/index.js";
export { createPdfiumEngine, type PdfiumEngine, type PdfiumEngineOptions } from "./pdfium/index.js";
