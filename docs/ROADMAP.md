# Roadmap — zero-upload PDF suite

## Priority decision (2026-10-16)

**English first.** Reach Acrobat-level features in English, then extend to
Malayalam, Hindi and other Indian languages. `docs/ADOBE-PARITY.md` is the
concrete gap list that drives the order of work.

This does not remove the Indic support already built — OCR language packs are
opt-in downloads, Malayalam extraction is verified on real documents, and search
folds Malayalam chillu spellings — it means no further work waits on sourcing
Indic scans. Worth revisiting consciously: `docs/PRODUCT.md` names Indic OCR as
the third reason this beats Acrobat, and in-place text editing (the largest
parity gap) is a Phase 5 item, so strict sequencing would defer the
differentiator a long way.

Each phase ships at least one usable release, keeping the lab's one-launch-per-month cadence. Tick items only when implemented **and** tested.

## Phase 0 — Foundations (weeks 1–4)
- [x] pnpm monorepo scaffold (apps/web, packages/engine, core, workers, ui)
- [x] CI: lint, typecheck, unit tests, `check:licenses`, offline e2e test
- [x] Strict CSP (`connect-src 'self'`) and offline e2e test passing on an empty app
- [ ] Engine spike: PDFium-WASM vs pdf.js on 100 corpus files → ADR 0002. Run on 14 files so far (8 real Malayalam/Hindi government PDFs): PDFium is 3–900x faster and extracts more text, but fails on a damaged header that pdf.js opens — the qpdf repair pass covers that gap
- [x] OCR spike: Tesseract on generated Malayalam + Hindi samples → ADR 0004 (eng 100%, hin 100%, mal 89% which turned out to be a chillu spelling mismatch, now fixed in search). Real scans still needed
- [x] Corpus runner script (`pnpm corpus`) — drives the real worker pipeline (open with repair, render, round-trip, re-open), fails on any regression against the last clean run, and records no filenames
- [ ] Reach the 1,000-file test corpus (kept out of git). 41 files so far: `pnpm corpus:samples` (public-domain Malayalam/Hindi government documents plus generated edge cases), `pnpm corpus:lsgkerala` (Kerala LSGD, 25 real Malayalam PDFs) and the lab's own files. Still missing: **image-only scans**, grade cards, exam papers, DSC-signed letters

**Gate:** engine chosen, ADR merged, offline test green.

## Phase 1 — View and organize (months 1–2) → Release 1 (web PWA)
- [x] Viewer: virtualised pages (only the visible window is mounted), fit-to-width, thumbnails
- [x] Viewer: zoom controls (buttons and Ctrl/Cmd +/-/0), drag-and-drop open, Ctrl/Cmd+F to search
- [x] Viewer: fit page, outline/bookmarks panel (sidebar tabs, click to jump)
- [x] Interface: a minimal top bar, a sidebar with Pages/Marks/Form/Bookmarks, and a right-hand tools panel grouped by task, replacing the single row of 25 controls
- [ ] Viewer: bitmap cache across zoom levels — deliberately not done: pages are
  transferred into the canvas zero-copy, and `transferFromImageBitmap` consumes
  the bitmap, so caching would cost a full copy of every page drawn. Revisit if
  re-rasterising on zoom actually hurts on the corpus
- [x] Text search with highlights — case- and Unicode-normalisation-insensitive, so Malayalam and Hindi match whichever form the document uses (unit-tested). Highlights are line-level: narrowing them to the matched substring needs glyph quads from the engine
- [x] Verify Indic extraction against real Malayalam documents: across 40 opened files from Kerala LSGD and the Kerala Assembly, 22% of extracted page-1 characters sit in the Malayalam Unicode block (64% Latin, 5% digits). `pnpm corpus` reports the mix
- [ ] Verify Indic extraction from *scanned* pages, and for Hindi — every real document collected so far is born-digital, so OCR on real Indic scans is still unmeasured
- [x] Annotate: highlight (snapped to text lines), sticky note, free text — written as real PDF annotation objects, so the text underneath survives and other viewers can edit them
- [x] Annotate: underline and strike-through (real `/Underline` and `/StrikeOut`, opaque where a highlight is a tint)
- [x] Annotate: freehand (Ink), box (Square), oval (Circle), and a colour palette for every kind
- [x] A Marks panel listing every annotation with its page, click to jump, click to remove
- [ ] Annotate: stamps; reply/resolve threads (needs `/IRT` and `/RT`); editing a mark after placing it; lines and arrows — deliberately absent because PDFium does not synthesise an appearance for `/Line`, so one would be in the file and invisible in our own viewer. Lands with `/AP` generation
- [x] Organize: merge, insert at a position, reorder (drag thumbnails or the keyboard controls), rotate, delete, extract selected pages, save via native dialog
- [x] `packages/core`: merge, split, reorder and rotate on pdf-lib, unit-tested
- [x] Organize: split into several files — each selected page starts a new part, one save dialog per part (a single archive would need a zip writer)
- [x] Compress, password protect / remove password (qpdf.wasm) — ADR 0003
- [x] Repair-on-open fallback for malformed files (recovers a mangled header or junk prefix; a destroyed xref still fails — see ADR 0003)
- [x] Installable PWA, fully offline after first load (engine starts with the network cut)

**Gate:** renders the corpus with no regressions.

## Phase 2 — OCR, forms, redaction, desktop (months 3–4) → Release 2 (desktop + web)
- [x] Tauri desktop app: **builds and runs** on macOS (23 MB binary, ~1 min). The window opens, the web UI loads, and PDFium's wasm compiles under the Tauri CSP — the failure most expected, which did not happen. Capability set is file dialogs and nothing else: **no HTTP permission, no updater**, so the shell cannot reach the network even by accident. ADR 0005
- [x] Desktop: native open and save dialogs, with Save writing back to the file that was opened. Two audited Rust commands rather than the filesystem plugin, whose path scope would have to be most of the home directory
- [ ] Desktop: Windows and Linux builds (CI job added, never run) and bundled installers
- [ ] Desktop: build it, add the icon set, and replace the File System Access fallbacks with native dialogs — WKWebView has no FSA, so inside the shell the app would quietly use the `<input type=file>` and download paths
- [x] OCR to searchable PDF in the app (browser): eng, mal, hin; pages that already have text are skipped, not re-recognised. Assets served from our own origin, fetched on first use rather than precached
- [x] OCR preprocessing: despeckle (3×3 median), on by default — turns 8% speckle from 0% accuracy into 100% (ADR 0004)
- [ ] OCR: desktop native Tesseract and batch folders; deskew (would recover the 4 points despeckling costs on a 5° skew); per-page language detection
- [x] Forms: fill and save AcroForms (text, multiline, checkbox, radio, dropdown, option list), with flattening; read-only fields respected, XFA-only forms reported rather than shown empty
- [ ] Forms: a builder for creating fields, and filling by clicking the widgets on the page instead of the side panel
- [x] True redaction: page objects touching the area are removed via PDFium and the result is re-read to prove no text survives. Granularity is per text run, so an overlapping run goes whole — the safe direction, and the count is reported
- [ ] Redaction: redact by search hit ("remove every occurrence of this number") and a redaction report listing what was removed
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
- [x] In-place text editing: editing an existing run's text works through PDFium's `FPDFText_SetText`, keeping font, size, colour and position
- [x] In-place text editing: paragraph detection and reflow (blocks re-wrap to their own width, measured in the real font by PDFium), and font substitution to Helvetica when the document's font has no glyph for what was typed — refused outright when no standard font has it either
- [x] In-place text editing: changing a block's size and face from a format bar over the text, limited to the PDF standard fonts
- [x] Undo and redo across both layers — page order and marks in the app, document bytes in the worker — with the usual keys, plus right-click menus on pages and Delete for the selected ones
- [x] Bookmarks that can be written: add, rename, move, remove, as a real `/Outlines` tree
- [x] Pictures that can be moved, resized and removed in place
- [x] Find-and-redact by pattern: Aadhaar, PAN, phone, email and words, with per-character boxes so a match is removed without taking its line with it
- [x] Remove hidden information: description, XMP, embedded files, scripts and actions, with comments and links optional
- [x] Lines, arrows, stamps and a drawn signature, with generated `/AP` appearance streams — the thing that blocked all four
- [x] Print, by handing the document to the platform's own PDF viewer rather than rasterising it
- [x] Selectable, copyable text: a transparent text layer over the canvas, laid out from the extracted runs
- [x] Document properties: title, author, subject, keywords
- [x] Headers, footers, page numbers and Bates numbering, with number styles (1, i, I, a, A), a start number, zero-padding and a page range
- [ ] In-place text editing: adding a new paragraph in the document's own font, formatting a selection within a block, embedding an arbitrary font, and pushing following content down when a block grows
- [ ] Image replace in place, and cropping or rotating one
- [ ] Accessibility tagging + PDF/UA checks
- [ ] Mobile: view, annotate, sign
