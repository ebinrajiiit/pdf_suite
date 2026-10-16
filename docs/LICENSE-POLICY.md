# Dependency licence policy

The paid editions are closed source, so every shipped dependency must have a permissive licence. One AGPL dependency would force the whole product open or require a commercial licence.

## Allowed
MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, 0BSD, Zlib, CC0-1.0, Unlicense, MPL-2.0 (unmodified or with modified files published), BlueOak-1.0.0, Python-2.0.

IJG — **bundled binaries only** (libjpeg-turbo, linked into qpdf.wasm). Permissive and attribution-only; accepted by ADR 0003 on 2026-10-16.

Unicode-3.0 — the ICU crates Tauri links into the desktop binary. Permissive and attribution-only; accepted by ADR 0005 on 2026-10-16.

The allow-list is `scripts/allowed-licences.json`, read by both checkers. This file is the reasoning; that file is what runs.

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
| qpdf | Apache-2.0 (verified: 12.2.0 via `--version`; links libjpeg-turbo and zlib — ADR 0003) |
| Tesseract | Apache-2.0 |
| LibreOffice (separate process, desktop only) | MPL-2.0 — invoked as an external program, not linked |
| veraPDF (if used) | dual GPL/MPL — use under MPL only |

## Process
1. Before adding a dependency: `pnpm check:licenses` for npm and the bundled wasm components, and `pnpm check:licenses:rust` for the crates compiled into the desktop binary. The second needs a Rust toolchain and runs in the desktop CI job.
2. Non-npm components (WASM builds, native binaries) are listed in `scripts/third-party.json` with licence and source URL. `licence` must be an SPDX expression: `check:licenses` validates those entries against the allow-list too, because npm metadata cannot see code compiled into a wasm blob.
3. A new licence category needs an ADR.
4. Release builds ship a generated `THIRD_PARTY_NOTICES.txt` covering npm packages, the bundled wasm components and the Rust crates in the desktop binary: `pnpm notices` writes it and `pnpm check:notices` (in CI) fails when it is stale. The generator refuses to write the file if any shipped component has no licence text, so a missing notice cannot slip into a release.
5. Upstream licence texts that a package does not ship are fetched into `notices/` and committed, pinned to the version we link. A dependency whose upstream publishes no text at all is recorded in `notices/declared-only.json` with a reason and a date — an audited exception, never a silent pass.
