# ADR 0002 — Rendering engine: PDFium-WASM vs pdf.js

- Status: **Proposed** — now measured on 14 documents including real Malayalam and Hindi government PDFs, which changed the picture but is still far short of the 100 the gate asks for, and includes no image-only scans. See "First real-document run" and "What must happen before this is accepted".
- Date: 2026-10-16 (updated the same day with the first real-document numbers)

## Context

`packages/engine` defines one `PdfEngine` interface so the renderer stays swappable (CLAUDE.md §4). Phase 0 has to choose the primary adapter for Phase 1's viewer. Both candidates are permissively licensed, both run entirely on the device, and both are now implemented:

- `packages/engine/src/pdfjs` — pdf.js via `pdfjs-dist` 6.4.299 (Apache-2.0).
- `packages/engine/src/pdfium` — PDFium via `@embedpdf/pdfium` 2.15.1 (MIT wrapper around PDFium, BSD-3-Clause).

`pnpm check:licenses` passes with both installed. Both are recorded in `scripts/third-party.json`.

## Method

`scripts/bench-engines.mjs` serves `packages/engine/bench` with Vite and drives it in headless Chromium, so measurements include wasm compilation, worker startup and `OffscreenCanvas` rasterisation — the real browser path, not a Node approximation. Per file and per engine it records open time, first-page render time at scale 1.5, text-extraction time, extracted character count, and the engines' page-1 rasters are compared pixel by pixel. Peak memory is the RSS of the browser process tree sampled from Node at 100 ms; `--engine pdfjs|pdfium` runs one engine with the other absent so that number is attributable.

Corpus bytes are fetched by the page from localhost and go nowhere else. Per-file rows are written to `corpus-report/` (git-ignored); only aggregates are printed.

```
pnpm bench:engines --synthetic            # generated fixtures, no corpus needed
pnpm bench:engines                        # the real corpus, once it exists
pnpm bench:engines --engine pdfium        # attributable peak memory
```

### Why the numbers below are provisional

`corpus/` is empty, so the run used 6 generated fixtures (1/50/500-page text, vector-heavy, a 90°-rotated page, and a deliberately truncated file). They contain **no scanned pages, no CJK or Indic text, no forms, no encryption and no real-world malformation** — which is most of what the decision actually turns on.

## Results (6 synthetic fixtures, scale 1.5, headless Chromium, M-series macOS)

| | pdf.js | PDFium |
| --- | --- | --- |
| Engine init | ~0 ms (worker spawns lazily, paid on first open) | 17 ms (wasm compile, paid up front) |
| Open, median / p95 | 92 ms / 340 ms | 0.3 ms / 2.0 ms |
| First-page render, median / p95 | 20 ms / 41 ms | 7.4 ms / 26 ms |
| Page-1 text extraction, median | 2.5 ms | 0.7 ms |
| Peak browser RSS over the run (engine alone) | +329 MB over a 141 MB baseline | +210 MB over a 148 MB baseline |
| PDFium wasm linear memory, peak | — | 17.8 MB |
| Characters extracted (all fixtures) | 6,131 | 6,131 |
| Failures | 1 (the truncated file) | 1 (the truncated file) |

Raster agreement: 5 pages compared, median absolute difference **1.45 %**, none above 2 %, no page-size disagreements. The two engines are drawing the same thing; the residual is antialiasing and text rasterisation.

Both engines reject the truncated file, as expected — Phase 1 routes that case through a qpdf repair pass and retries (CLAUDE.md §4).

### Self-hosted asset weight

Nothing may come from a CDN (`docs/PRIVACY.md`), so every asset is precached by the service worker.

| pdf.js | raw | gzip | | PDFium | raw | gzip |
| --- | --- | --- | --- | --- | --- | --- |
| `pdf.mjs` | 844 KB | 0.2 MB | | `pdfium.wasm` | 4.4 MB | 2.0 MB |
| `pdf.worker.mjs` | 2.1 MB | 0.5 MB | | glue JS | 292 KB | 0.1 MB |
| `cmaps/` | 1.6 MB | 0.9 MB | | | | |
| `standard_fonts/` | 816 KB | 0.5 MB | | | | |
| `wasm/` (OpenJPEG, qcms) | 1.5 MB | 0.5 MB | | | | |
| `iccs/` | 20 KB | ~0 | | | | |
| **total** | **6.9 MB** | **2.6 MB** | | **total** | **4.7 MB** | **2.1 MB** |

pdf.js's weight is divisible — CJK cmaps can be loaded on demand from our own origin — whereas PDFium's wasm is one indivisible 4.4 MB download.

## Findings from implementing both adapters

These cost more than the timings did and are the durable part of this spike.

1. **`@embedpdf/pdfium` defaults to a CDN.** Its `DEFAULT_PDFIUM_WASM_URL` points at jsDelivr. Using it would break privacy invariants 2 and 3 (CLAUDE.md §1), so `createPdfiumEngine` requires either `wasmBinary` or a same-origin `wasmUrl`, and rejects a cross-origin one. `src/pdfium/no-cdn.test.ts` fails if that constant ever appears in adapter code. Emscripten resolves the wasm filename before it consults `wasmBinary`, so `locateFile` must answer with a bare relative name rather than throwing.
2. **pdf.js also has CDN defaults**, for cmaps and standard fonts. Every asset URL is therefore a required constructor option on `createPdfjsEngine`, with `useWorkerFetch: false` and `useSystemFonts: false` so the worker never fetches anything itself.
3. **PDFium's page size ignores `/Rotate`.** `EPDF_GetPageSizeByIndexNormalized` returns the unrotated box — "normalized" does not mean rotation-applied. A 90°-rotated page reported portrait dimensions and rendered into a portrait bitmap. The adapter now applies the quarter-turn rotation itself; the benchmark's page-size disagreement count went from 1 to 0, which is how the bug was caught.
4. **`DocHandle.pageSize` being synchronous penalises pdf.js.** pdf.js parses page dictionaries on demand, so the adapter must call `getPage` for every page inside `open()` to satisfy a synchronous `pageSize`. That prefetch is 13 ms of the 500-page fixture's open time today and will scale with page count on real documents. PDFium reads sizes by index with no page load, so it pays nothing. **Recommendation independent of the engine choice: make `pageSize` async in Phase 1**, or add `pageSizes(range)`; then pdf.js's open time becomes comparable.
5. **pdf.js v6 no longer needs `'unsafe-eval'`** (`isEvalSupported` is gone), and both engines run under the CSP in `docs/PRIVACY.md` unchanged — `'wasm-unsafe-eval'` covers both. Verified by the adapters running in the benchmark page.
6. **No browser memory API covers both engines.** `performance.measureUserAgentSpecificMemory()` is unavailable in Playwright's Chromium build even cross-origin-isolated, and `usedJSHeapSize` misses PDFium's wasm memory and pdf.js's worker heap. Hence process-tree RSS, which is coarse but comparable.

## Second real-document run: 41 files, 1,424 pages

With the Kerala LSGD documents added (`pnpm corpus:lsgkerala`), the gap holds and
widens on text extraction.

| | pdf.js | PDFium |
| --- | --- | --- |
| Open, median / p95 | 93 ms / 119 ms | **0.3 ms / 1.5 ms** |
| First-page render, median / p95 | 43 ms / 58 ms | **19 ms / 28 ms** |
| Text extraction, median | 2.8 ms | **1.2 ms** |
| Characters extracted (41 files) | 37,645 | **39,748** |
| Peak browser RSS | **13.8 MB** | 17.7 MB |
| Files it could not open | **2** | 3 |

Raster agreement: 38 pages compared, median difference 1.40 %, **6 files above
2 %** — those six are the pages a human should look at before this ADR is
accepted, and the reason the benchmark reports that number at all.

The one extra PDFium failure is still the damaged header, still covered by the
qpdf repair pass in the app.

## First real-document run

`node scripts/fetch-sample-corpus.mjs` pulls public-domain Indian government
documents — Kerala Legislative Assembly proceedings in Malayalam, Rajya Sabha and
eParlib debates in Hindi — alongside generated edge cases (mangled header, junk
prefix, truncated body, every page rotation, 500 pages, AES-256 encrypted). 14
files, 530 pages.

| | pdf.js | PDFium |
| --- | --- | --- |
| Open, median / p95 | 92 ms / 397 ms | **0.1 ms / 2.6 ms** |
| First-page render, median / p95 | 36 ms / 58 ms | **12 ms / 44 ms** |
| Text extraction, median | 1.9 ms | **0.8 ms** |
| Characters extracted (all files) | 12,044 | **12,500** |
| Peak browser RSS (both engines in one run) | 11.7 MB | 14.9 MB |
| Files it could not open | **2** | 3 |

Raster agreement on real documents: 11 pages compared, median difference
**0.98 %**, one file above 2 %, no page-size disagreements.

### The finding that complicates the choice

**PDFium is less tolerant of a damaged file than pdf.js.** The mangled-header
document opens in pdf.js and not in PDFium — the one failure separating them,
since both correctly refuse the truncated file and both correctly demand a
password for the encrypted one.

This matters less than it looks, because the app does not call the engine raw:
`pnpm corpus` reports that same file as **repaired on open and then opened**, via
the qpdf pass from ADR 0003. So the pipeline is at least as tolerant as pdf.js,
while keeping PDFium's speed. It does mean the engine choice and the repair
fallback are now coupled: dropping qpdf would make PDFium strictly worse than
pdf.js on damaged input.

The other change from the synthetic run: PDFium now extracts *more* text than
pdf.js (12,500 vs 12,044 characters) on documents with real Indic text layers,
where the synthetic fixtures had them exactly equal.

## Options

1. **PDFium primary, pdf.js not shipped.** Fastest on every measured axis, one smaller download, and the same engine Chrome itself uses. Costs: a 4.4 MB indivisible wasm payload, a precompiled binary we do not build ourselves, and a C++ engine whose crashes are harder to diagnose from TypeScript.
2. **pdf.js primary, PDFium not shipped.** Pure JS, debuggable, incremental assets, maintained by Mozilla with a large PDF test corpus behind it. Costs: slower open and render here, and a text layer whose coordinates are baseline-relative.
3. **Both behind the interface, PDFium primary with pdf.js as the fallback.** The interface already supports it and both adapters exist and pass. Costs: both payloads precached (4.7 MB of assets that most users never load), two code paths to keep correct, and two sets of rendering quirks in bug reports.

## Decision (proposed, not yet accepted)

**Option 1: PDFium as the primary engine, with pdf.js retained in the repo as a benchmark and correctness oracle but not shipped in the Phase 1 bundle.**

Reasons: it is faster on open (the metric that governs the "page 1 in under 2 s for a 200 MB, 500-page scan" target in `docs/ARCHITECTURE.md`), it is lighter to ship once pdf.js's cmaps and fonts are counted, its synchronous by-index API fits `DocHandle` without prefetching, and it is the engine Chrome ships, so its fidelity on institutional documents is well exercised. Keeping the pdf.js adapter costs nothing at runtime and gives us a second opinion whenever a corpus file renders oddly — which is exactly what caught finding 3.

Confidence is **low** until the corpus run happens. The fixtures exercise none of the cases most likely to reverse this: 200 MB scans, Malayalam and Hindi text layers, broken xrefs, and encrypted files.

## What must happen before this is accepted

- [x] A starter corpus exists: 14 files, 8 of them real public-domain Malayalam and Hindi government documents (`pnpm corpus:samples`).
- [ ] Reach at least 100 files spanning `scanned/`, `forms/`, `signed/`, `malformed/`, `large/` and `office/`. The starter set has **no image-only scans**, no forms, and nothing signed with a DSC — so fidelity on photocopies and on scanned Indic text is still unmeasured.
- [ ] `pnpm bench:engines` over them, plus `--engine pdfjs` and `--engine pdfium` for attributable memory.
- [ ] Confirm the 200 MB / 500-page target: open and show page 1 under 2 s.
- [ ] Eyeball every page where the engines disagree by more than 2 %.
- [ ] Compare extracted Indic text against the scanned source — character counts matching is not the same as text being correct.
- [ ] Decide `pageSize` sync vs async (finding 4) and record it here.
- [ ] Record the PDFium build's provenance, or reproduce the wasm build ourselves (`scripts/third-party.json`).

## Consequences

- `packages/engine` keeps two adapters; only one is bundled by `apps/web`. Engine-specific behaviour must never leak past `PdfEngine`.
- Every engine asset URL is injected by the app from its own bundle. No adapter may hold a default URL.
- The benchmark is a standing tool, not spike scaffolding: re-run it whenever either engine is upgraded.
- If PDFium is accepted, the 4.4 MB wasm dominates first load and must be precached by the service worker and served from our own origin.
