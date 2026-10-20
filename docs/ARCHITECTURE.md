# Architecture — zero-upload PDF suite

## Principle
The app is a **local tool that happens to be delivered by the web**. After the first load (or after installing the desktop app), it needs no server. There is no backend, no database and no object store.

## Two delivery forms, one codebase

```
┌──────────────────────────────────────────────────────────────┐
│ UI: React (packages/ui, apps/web)                            │
├──────────────────────────────────────────────────────────────┤
│ Command layer: typed requests → workers (packages/workers)   │
├───────────────────────────────┬──────────────────────────────┤
│ Browser (PWA)                 │ Desktop (Tauri 2)            │
│ Web Workers + WASM:           │ Same workers, plus Rust      │
│  • PdfEngine (PDFium/pdf.js)  │ commands for heavy/native:   │
│  • pdf-lib (structure edits)  │  • native Tesseract (batches)│
│  • qpdf.wasm (repair/encrypt) │  • LibreOffice (Office→PDF)  │
│  • tesseract.wasm (OCR)       │  • PKCS#11 (USB DSC tokens)  │
│  • WebGPU model (Phase 4)     │  • llama.cpp (Phase 4)       │
├───────────────────────────────┴──────────────────────────────┤
│ Local file I/O: File System Access API / Tauri fs dialogs    │
└──────────────────────────────────────────────────────────────┘
          No arrows leave this box except the four allowed
          calls in PRIVACY.md (hash-only or version-only).
```

## Packages

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `packages/engine` | `PdfEngine` interface: open, page count, render page to bitmap, extract text with positions, search. Adapters: `pdfium`, `pdfjs`. | WASM engines |
| `packages/core` | Pure functions over bytes: merge, split, reorder, rotate, delete, insert, crop, compress, encrypt/decrypt, set metadata. | pdf-lib, qpdf.wasm |
| `packages/workers` | Worker entry points and a typed request/response protocol (with progress events and cancellation). | engine, core, ocr |
| `packages/ocr` | Rasterise → Tesseract → write invisible text layer. Language packs loaded from the bundle or an opt-in one-time download. | engine, tesseract |
| `packages/ui` | Viewer, thumbnails, annotation tools, dialogs. | — |
| `apps/web` | PWA shell, service worker, routing. | all packages |
| `apps/desktop` | Tauri shell + Rust commands. | apps/web build |

## Key interfaces (starting point)

```ts
// packages/engine/src/types.ts
export interface PdfEngine {
  open(bytes: ArrayBuffer, opts?: { password?: string }): Promise<DocHandle>;
}
export interface DocHandle {
  pageCount(): number;
  pageSize(index: number): { width: number; height: number }; // PDF points
  renderPage(index: number, scale: number): Promise<ImageBitmap>;
  extractText(index: number): Promise<TextRun[]>;
  close(): void;
}
export interface TextRun { text: string; x: number; y: number; w: number; h: number; }

// packages/core/src/ops.ts — every op: bytes in, new bytes out
export type PdfBytes = Uint8Array;
export declare function merge(inputs: PdfBytes[]): Promise<PdfBytes>;
export declare function split(input: PdfBytes, ranges: [number, number][]): Promise<PdfBytes[]>;
export declare function reorder(input: PdfBytes, order: number[]): Promise<PdfBytes>;
export declare function rotate(input: PdfBytes, pages: number[], degrees: 90 | 180 | 270): Promise<PdfBytes>;
```

## Performance rules
- Render only visible pages plus one page of look-ahead; drop bitmaps off-screen.
- Keep one engine instance per worker; pool 2–4 workers depending on `navigator.hardwareConcurrency`.
- Transfer `ArrayBuffer`s; never structured-clone large documents.
- Target: open a 200 MB, 500-page scanned PDF and show page 1 in under 2 s on an M1 MacBook.

## Persistence
- Nothing is stored unless the user saves.
- Optional local settings (theme, recent files list) in IndexedDB, opt-in, clearable from Settings.
- PWA cache holds only the app's own code, WASM and language packs, never documents.

## Running one e2e test

`pnpm e2e` builds the app and starts `vite preview` before the tests. Running a
single test with `pnpm exec playwright test -g "..."` reuses a preview that is
already running (`reuseExistingServer` in `playwright.config.ts`), and that
server serves whatever was built last — so a targeted run can test code from
twenty minutes ago, and fail or pass for no reason visible in the diff.

Kill it first: `lsof -ti:4173 | xargs kill`.

## Decisions still open
| Decision | When | ADR |
| --- | --- | --- |
| PDFium-WASM vs pdf.js as primary renderer | Phase 0 spike | 0002 |
| Signing library (PAdES, PKCS#11) | Phase 3 spike | TBD |
| Local AI model and runtime | Phase 4 | TBD |
| Product name | Before Phase 1 release | — |
