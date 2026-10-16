# ADR 0004 — OCR with Tesseract in WebAssembly

- Status: **Proposed** — the spike answers the feasibility questions, but the accuracy numbers come from generated images, not scans. Accept it once the corpus has real Malayalam and Hindi documents.
- Date: 2026-10-16

## Context

Indic OCR is the product's headline differentiator (`docs/PRODUCT.md`): Malayalam and Hindi have to be first-class, and everything must run on the device. Phase 0 called for an OCR spike before committing; this is it, and it also opens Phase 2's "OCR to searchable PDF" item.

## Decision

**Tesseract via `tesseract.js` 7.0.0 (Apache-2.0), wrapped in `packages/ocr`** with every asset — worker script, wasm core, and language data — required as a same-origin URL. There are no defaults, because tesseract.js's defaults point at jsDelivr, which privacy invariants 2 and 3 forbid. This is the third library in a row whose defaults had to be disarmed (PDFium's `DEFAULT_PDFIUM_WASM_URL`, pdf.js's cmap and font URLs), so the pattern is now deliberate: a wrapper in this repo never carries a remote URL.

## What the spike measured

`node scripts/fetch-tessdata.mjs && node scripts/ocr-spike.mjs` renders known text to a canvas with a system font, OCRs it, and scores the result by edit distance. Everything is served from one local origin.

| Sample | Font present | Init | OCR | Confidence | Accuracy |
| --- | --- | --- | --- | --- | --- |
| English — "Result sheet for semester one 2026" | yes | 179 ms | 97 ms | 95 | **100%** |
| Malayalam — "കേരള സർവകലാശാല പരീക്ഷാ ഫലം" | yes | 123 ms | 92 ms | 91 | **89%** (see below) |
| Hindi — "परीक्षा परिणाम विद्यार्थी का नाम" | yes | 117 ms | 96 ms | 95 | **100%** |

**Requests to a non-local origin: none.** The whole pipeline runs from our own origin, which is the arrangement a release needs.

### The Malayalam 89% is not an OCR error

Tesseract read the word correctly and spelled it differently:

```
expected  സർവകലാശാല    …U+0D7C…                 (atomic chillu)
returned  സര്‍വകലാശാല  …U+0D30 U+0D4D U+200D…   (consonant + virama + ZWJ)
```

Both are correct Malayalam. **Neither NFC nor NFKC reconciles them**, which was verified rather than assumed. Semantically the recognition was perfect; the 89% is a Unicode representation mismatch.

This would have been a silent product bug: a user searching for a word typed the normal way would never find the OCR'd text. `packages/engine/src/search.ts` now strips ZWJ/ZWNJ and folds atomic chillus to their base-plus-virama spelling, with the OCR output itself as the test fixture. **Finding this is what the spike was for** — no amount of Latin testing would have surfaced it.

### Searchable PDF comes free

`tesseract.js` can emit a searchable PDF directly (25–35 kB per sample here), and it works in the browser build. That removes the problem I expected to be hardest: an invisible text layer needs a font covering the script, and embedding a Malayalam or Devanagari font would mean finding one we are licensed to ship and paying its size. Tesseract writes the layer with its own glyphless font instead.

### Asset weight decides the delivery

| Language data (tessdata_fast) | Size |
| --- | --- |
| eng | 3.9 MB |
| mal | 5.0 MB |
| hin | 1.1 MB |
| **total** | **10.0 MB** |

Plus the wasm core. Too much to bundle for every user, so: **language packs are an opt-in one-time download from our own release host**, which is the only form `docs/PRIVACY.md` permits. `scripts/fetch-tessdata.mjs` fetches them into a git-ignored `vendor/` for development and prints SHA-256 digests; a release must pin and host them, and `THIRD_PARTY_NOTICES.txt` must carry their Apache-2.0 licence.

## Accuracy against degradation (ground truth known)

A real scan carries no ground truth, so no accuracy can be computed from one —
only an impression. `node scripts/ocr-accuracy.mjs` instead degrades a page whose
text we know, one axis at a time, so a drop can be attributed. 300 dpi unless
stated, 18 pt text.

| Degradation | English | Malayalam |
| --- | --- | --- |
| clean | **100 %** | 89 % |
| JPEG quality 60 % | **100 %** | 89 % |
| skew 1.5° | **100 %** | 89 % |
| skew 5° | 96 % | 89 % |
| blur 1 px | **100 %** | 89 % |
| blur 2 px | **100 %** | 89 % |
| speckle 2 % | 89 % | 74 % |
| **speckle 8 %** | **0 %** | **0 %** |
| 150 dpi | **100 %** | 89 % |
| combined "bad photocopy" | 88 % | 83 % |

### Two findings that change what to build

**Speckle is the failure mode, not skew or blur.** Tesseract shrugged off 2 px of
blur, 5° of skew, JPEG at 60 % and a drop to 150 dpi — all at or near 100 % — but
2 % salt-and-pepper noise cost 11 points and **8 % noise produced nothing at all,
with confidence 0**. The earlier version of this ADR listed "deskew, despeckle and
binarisation" as equally worth doing; that was a guess, and it was wrong.
**Despeckle first**, and treat a confidence of 0 as "this page needs cleaning up",
not "this page has no text".

**Malayalam's 89 % ceiling is not misrecognition.** It is identical at every
degradation level — clean, blurred, skewed, downsampled — which is not how
recognition errors behave. It is the chillu spelling difference: Tesseract returns
the ZWJ form where the ground truth uses the atomic letter. `fold()` in
`packages/engine/src/search.ts` already reconciles the two, so search finds the
text either way; the 89 % is measuring Unicode representation, not quality. A
character-accuracy figure for Malayalam therefore has to fold before comparing,
or it will understate by about 11 points forever.

## What these numbers are not

Generated images are the best case: no skew, no speckle, no JPEG artefacts, no faint photocopies, no mixed scripts on one page, and 36 pt text. Real exam papers and letters will score lower, and the gap is exactly what the corpus is for. The per-sample timings also cover a single line, not a page.

Open questions the corpus must settle:

- [ ] Accuracy on real scanned Malayalam and Hindi documents, including photocopies and mixed English/Indic pages. **Still open, and now known to be harder to source than expected:** 41 real documents have been collected, including 25 Malayalam PDFs from Kerala LSGD, and *every one of them is born-digital with a text layer*. `pnpm corpus --ocr mal,eng` runs OCR over any page without text and reports what came back; it currently finds none to run on. Scanned pages have to come from the lab's own scanners.
- [ ] Whether `tessdata_fast` is good enough or `tessdata_best` (larger, slower) is needed for Indic scripts.
- [ ] Page-level timings at 300 dpi, and whether a 500-page batch needs the desktop's native Tesseract (Phase 2 names it for exactly this).
- [ ] Whether Tesseract's own searchable-PDF output is good enough, or we need our own text layer for better word boxes.
- [ ] Preprocessing: deskew, despeckle and binarisation are where scanned-document accuracy is usually won.

## Consequences

- `packages/ocr` exists with no remote URLs; the app must pass bundled asset paths, as it already does for PDFium and qpdf.
- Language data is never committed. Development fetches it; a release hosts it.
- Caching language data is off by default (`cache: "none"`). `docs/PRIVACY.md` permits caching language packs locally, never documents, so turning it on is a deliberate choice with a visible setting.
- OCR output must be folded before it is searched. That rule now lives in `fold()` with the chillu case covered; other scripts may need their own rules, and each should arrive with a failing test from real text.
