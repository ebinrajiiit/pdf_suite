# Roadmap — zero-upload PDF suite

Each phase ships at least one usable release, keeping the lab's one-launch-per-month cadence. Tick items only when implemented **and** tested.

## Phase 0 — Foundations (weeks 1–4)
- [x] pnpm monorepo scaffold (apps/web, packages/engine, core, workers, ui)
- [x] CI: lint, typecheck, unit tests, `check:licenses`, offline e2e test
- [x] Strict CSP (`connect-src 'self'`) and offline e2e test passing on an empty app
- [ ] Engine spike: PDFium-WASM vs pdf.js on 100 corpus files (speed, fidelity, memory) → ADR 0002
- [ ] OCR spike: Tesseract on Malayalam + Hindi scanned samples (accuracy, speed in WASM)
- [ ] Corpus runner script (`pnpm corpus`)
- [ ] Start collecting the 1,000-file test corpus (kept out of git)

**Gate:** engine chosen, ADR merged, offline test green.

## Phase 1 — View and organize (months 1–2) → Release 1 (web PWA)
- [ ] Viewer: virtualised pages, zoom, fit modes, thumbnails, outline/bookmarks
- [ ] Text search with highlights (incl. Indic text)
- [ ] Annotate: highlight, underline, strike, sticky note, free text, freehand, stamps
- [ ] Organize: merge, split, reorder (drag thumbnails), rotate, delete, insert pages
- [ ] Compress, password protect / remove password (qpdf.wasm)
- [ ] Repair-on-open fallback for malformed files
- [ ] Installable PWA, fully offline after first load

**Gate:** renders the corpus with no regressions.

## Phase 2 — OCR, forms, redaction, desktop (months 3–4) → Release 2 (desktop + web)
- [ ] Tauri desktop app for macOS, Windows, Linux (same UI)
- [ ] OCR to searchable PDF: eng, mal, hin (browser: WASM; desktop: native, batch folders)
- [ ] Forms: fill and save AcroForms; basic form builder
- [ ] True redaction (remove content, not just cover it) with verification
- [ ] Office → PDF via LibreOffice (desktop only)
- [ ] Images ↔ PDF

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
