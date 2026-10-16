# Roadmap — zero-upload PDF suite

Each phase ships at least one usable release, keeping the lab's one-launch-per-month cadence. Tick items only when implemented **and** tested.

## Phase 0 — Foundations (weeks 1–4)
- [x] pnpm monorepo scaffold (apps/web, packages/engine, core, workers, ui)
- [x] CI: lint, typecheck, unit tests, `check:licenses`, offline e2e test
- [x] Strict CSP (`connect-src 'self'`) and offline e2e test passing on an empty app
- [ ] Engine spike: PDFium-WASM vs pdf.js on 100 corpus files (speed, fidelity, memory) → ADR 0002
- [x] OCR spike: Tesseract on generated Malayalam + Hindi samples → ADR 0004 (eng 100%, hin 100%, mal 89% which turned out to be a chillu spelling mismatch, now fixed in search). Real scans still needed
- [ ] Corpus runner script (`pnpm corpus`)
- [ ] Start collecting the 1,000-file test corpus (kept out of git)

**Gate:** engine chosen, ADR merged, offline test green.

## Phase 1 — View and organize (months 1–2) → Release 1 (web PWA)
- [x] Viewer: virtualised pages (only the visible window is mounted), fit-to-width, thumbnails
- [x] Viewer: zoom controls (buttons and Ctrl/Cmd +/-/0), drag-and-drop open, Ctrl/Cmd+F to search
- [x] Viewer: fit page, outline/bookmarks panel (sidebar tabs, click to jump)
- [ ] Viewer: bitmap cache across zoom levels — deliberately not done: pages are
  transferred into the canvas zero-copy, and `transferFromImageBitmap` consumes
  the bitmap, so caching would cost a full copy of every page drawn. Revisit if
  re-rasterising on zoom actually hurts on the corpus
- [x] Text search with highlights — case- and Unicode-normalisation-insensitive, so Malayalam and Hindi match whichever form the document uses (unit-tested). Highlights are line-level: narrowing them to the matched substring needs glyph quads from the engine
- [ ] Verify Indic *extraction* (not just matching) against real Malayalam and Hindi documents — needs the corpus
- [x] Annotate: highlight (snapped to text lines), sticky note, free text — written as real PDF annotation objects, so the text underneath survives and other viewers can edit them
- [x] Annotate: underline and strike-through (real `/Underline` and `/StrikeOut`, opaque where a highlight is a tint)
- [ ] Annotate: freehand and stamps; colour choice; editing an annotation after placing it; generating `/AP` appearance streams for viewers that do not synthesise them
- [x] Organize: merge, insert at a position, reorder (drag thumbnails or the keyboard controls), rotate, delete, extract selected pages, save via native dialog
- [x] `packages/core`: merge, split, reorder and rotate on pdf-lib, unit-tested
- [x] Organize: split into several files — each selected page starts a new part, one save dialog per part (a single archive would need a zip writer)
- [x] Compress, password protect / remove password (qpdf.wasm) — ADR 0003
- [x] Repair-on-open fallback for malformed files (recovers a mangled header or junk prefix; a destroyed xref still fails — see ADR 0003)
- [x] Installable PWA, fully offline after first load (engine starts with the network cut)

**Gate:** renders the corpus with no regressions.

## Phase 2 — OCR, forms, redaction, desktop (months 3–4) → Release 2 (desktop + web)
- [ ] Tauri desktop app for macOS, Windows, Linux (same UI)
- [x] OCR to searchable PDF in the app (browser): eng, mal, hin; pages that already have text are skipped, not re-recognised. Assets served from our own origin, fetched on first use rather than precached
- [ ] OCR: desktop native Tesseract and batch folders; preprocessing (deskew, despeckle); per-page language detection
- [x] Forms: fill and save AcroForms (text, multiline, checkbox, radio, dropdown, option list), with flattening; read-only fields respected, XFA-only forms reported rather than shown empty
- [ ] Forms: a builder for creating fields, and filling by clicking the widgets on the page instead of the side panel
- [ ] True redaction (remove content, not just cover it) with verification
- [ ] Office → PDF via LibreOffice (desktop only)
- [x] Images → PDF (JPEG/PNG, one page per image or fitted to a page size) and PDF → PNG per page

**Gate:** live in 3 offices at IIIT Kottayam.

## Phase 3 — Sign and comply (months 5–6) → Release 3 (Institution edition)
- [ ] Visual signatures (draw/type/image)
- [ ] Digital signatures: Class 3 DSC via PKCS#11 (desktop)
- [ ] PAdES with RFC 3161 timestamp (hash-only network call)
- [ ] Aadhaar eSign (hash-only network call) — after ESP partnership
- [ ] Signature validation panel
- [ ] Compare two versions (text + visual diff)
- [ ] PDF/A export + validation
- [ ] Offline machine-bound licensing for paid editions

**Gate:** first external institution signs on.

## Phase 4 — Local AI and automation (months 7–9)
- [ ] On-device summarise and "ask this document" (WebGPU / llama.cpp)
- [ ] Table extraction to CSV/Excel
- [ ] PDF → Word/Excel (beta, clearly labelled)
- [ ] Batch workflows: grade cards, certificates, result sheets from templates + CSV

**Gate:** licence revenue funds Phase 5, or decide to license an SDK for editing.

## Phase 5 — Parity (months 10–15)
- [ ] In-place text editing with font matching
- [ ] Image replace/move in place
- [ ] Accessibility tagging + PDF/UA checks
- [ ] Mobile: view, annotate, sign
