# Dependency licence policy

The paid editions are closed source, so every shipped dependency must have a permissive licence. One AGPL dependency would force the whole product open or require a commercial licence.

## Allowed
MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, 0BSD, Zlib, CC0-1.0, Unlicense, MPL-2.0 (unmodified or with modified files published), BlueOak-1.0.0, Python-2.0.

## Banned
AGPL-*, GPL-*, LGPL-* (when bundled into WASM or statically linked), SSPL, BUSL, Elastic-2.0, Commons Clause, CC-BY-NC, missing or unknown licences.

## Banned by name
| Package | Reason |
| --- | --- |
| MuPDF / mupdf.js / mupdf-wasm | AGPL |
| PyMuPDF (fitz) | AGPL |
| pdf2docx | Depends on PyMuPDF |
| Ghostscript | AGPL |

## Engines we intend to use (verify licence at time of adoption)
| Component | Licence (expected) |
| --- | --- |
| PDFium | BSD-3-Clause / Apache-2.0 |
| pdf.js | Apache-2.0 |
| pdf-lib | MIT |
| qpdf | Apache-2.0 |
| Tesseract | Apache-2.0 |
| LibreOffice (separate process, desktop only) | MPL-2.0 — invoked as an external program, not linked |
| veraPDF (if used) | dual GPL/MPL — use under MPL only |

## Process
1. Before adding a dependency: `pnpm check:licenses`.
2. Non-npm components (WASM builds, native binaries) are listed in `scripts/third-party.json` with licence and source URL.
3. A new licence category needs an ADR.
4. Release builds ship a generated `THIRD_PARTY_NOTICES.txt`.
