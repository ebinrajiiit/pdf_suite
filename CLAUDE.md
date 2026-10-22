# CLAUDE.md — Signet (FACTS-H Lab, IIIT Kottayam)

Product name: **Signet** — the seal ring that authenticates a document. The
repo keeps its codename, `pdf-suite`, and the workspace packages stay
`@pdf-suite/*`; only user-facing surfaces carry the product name.

An institutional PDF suite where **every operation runs on the user's device**. No document, page, extracted text or derived data ever leaves the machine.

Read `docs/PRODUCT.md`, `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` before starting any non-trivial task.

---

## 1. Non-negotiable rules

These override convenience, performance and feature requests. If a task seems to need breaking one, stop and ask.

### Privacy invariants (see `docs/PRIVACY.md`)
1. **Zero upload.** Document bytes, rendered pages, OCR text, form data, annotations and metadata never go over the network.
2. **No telemetry.** No analytics, crash reporting, error-tracking SDKs, fonts or CDNs loaded at runtime. All assets are self-hosted in the bundle.
3. **Allowed network calls (only these, each user-initiated and documented):**
   - Trusted timestamp (RFC 3161) — sends **only a hash**.
   - Aadhaar eSign — sends **only a hash** to the ESP.
   - Update check — opt-in, sends only the app version.
   - One-time download of optional language packs / AI models from our own release host.
4. **No silent persistence.** Documents are written only where the user chooses (File System Access API / native save dialog). Recent-files lists and thumbnails are opt-in and local.
5. CSP for the web app must keep `connect-src 'self'`. Never loosen it without an ADR in `docs/adr/`.
6. Every PR must pass the offline e2e test (`e2e/offline.spec.ts`), which fails on any request to a non-self origin.

### Licence policy (see `docs/LICENSE-POLICY.md`)
- Allowed: MIT, BSD-2/3-Clause, Apache-2.0, ISC, 0BSD, Zlib, CC0-1.0, MPL-2.0 (file-level copyleft is OK), Unlicense.
- **Banned:** AGPL, GPL (any version), LGPL in statically linked/bundled WASM, SSPL, BUSL, "Commons Clause", unknown/unlicensed.
- **Explicitly banned packages:** MuPDF, PyMuPDF/fitz, Ghostscript, pdf2docx (pulls PyMuPDF), any mupdf.js build.
- Run `pnpm check:licenses` before adding a dependency. CI enforces it.

---

## 2. Stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript (strict) everywhere; Rust only inside the Tauri shell |
| Package manager | pnpm workspaces |
| Web app | Vite + React + TypeScript, installable PWA, works fully offline after first load |
| Desktop | Tauri 2 (macOS, Windows, Linux) — wraps the same web UI + native helpers |
| Rendering | Phase 0 spike decides: PDFium compiled to WASM vs pdf.js (both permissive) |
| Structural edits | pdf-lib (MIT); qpdf compiled to WASM for repair/encrypt/linearize |
| OCR | Tesseract (WASM in browser, native in desktop); languages: eng, mal, hin first |
| Office → PDF | LibreOffice headless — **desktop only** (bundled or detected) |
| Signatures | Desktop: PKCS#11 for USB DSC tokens. Library TBD in Phase 3 spike |
| Local AI | Phase 4: WebGPU in browser / llama.cpp via Tauri; models downloaded once |
| Tests | Vitest (unit), Playwright (e2e, incl. offline test), corpus regression |
| Lint/format | ESLint + Prettier |

## 3. Repo layout (target)

```
apps/
  web/            Vite PWA — the main UI
  desktop/        Tauri shell (from Phase 2)
packages/
  engine/         Rendering abstraction (PdfEngine interface; pdfium + pdfjs adapters)
  core/           Pure document ops: merge, split, rotate, reorder, compress, encrypt
  workers/        Web Worker entry points + typed message protocol
  ocr/            OCR pipeline (Phase 2)
  ui/             Shared React components
corpus/           Local test PDFs — git-ignored, never committed
e2e/              Playwright tests
docs/             Product, architecture, roadmap, privacy, licence policy, ADRs
scripts/          Tooling (licence check, corpus runner)
```

## 4. Engineering conventions

- **Never block the main thread.** All parsing, rendering, OCR and conversion run in Web Workers (or Rust commands on desktop). Use transferable `ArrayBuffer`s; avoid copying large buffers.
- **One engine interface.** UI code talks to `packages/engine`'s `PdfEngine` interface, never directly to PDFium or pdf.js. This keeps the engine swappable.
- **Documents are immutable inputs.** Operations take bytes and return new bytes. Never mutate the user's original file in place; "Save" writes a new version.
- **Big files are normal.** Design for 500-page, 200 MB scanned PDFs. Stream/paginate; render only visible pages; cap worker memory.
- **Malformed PDFs are normal.** Run a qpdf repair pass when parsing fails, then retry.
- **Indic text first-class.** Test Malayalam and Hindi in OCR, search, and text extraction, not only English.
- Strict TypeScript, no `any` without a comment explaining why.
- Each feature lands with unit tests and, if user-facing, a Playwright test.

## 5. Commands

```
pnpm install
pnpm dev               # web app at http://localhost:5173
pnpm build
pnpm test              # unit tests (all packages)
pnpm e2e               # Playwright, includes offline/privacy test
pnpm lint
pnpm typecheck
pnpm check:licenses    # fails on any non-allow-listed licence
pnpm corpus            # render/round-trip every PDF in corpus/ and report failures
```

## 6. How to work in this repo

- For anything larger than a small fix: write a short plan first, list the files you'll touch, then implement.
- Architectural decisions (engine choice, signing library, new network call, new dependency category) get an ADR in `docs/adr/NNNN-title.md`.
- Tick items off in `docs/ROADMAP.md` when they're done and tested.
- Never commit anything from `corpus/`, real student/patient documents, or generated test output containing them.
