# ADR 0003 — qpdf in WebAssembly for repair, encryption and recompression

- Status: **Accepted** — the lab accepted the IJG licence for bundled binaries on 2026-10-16.
- Date: 2026-10-16

## Context

Three Phase 1 items are impossible with pdf-lib alone:

- **Repair on open.** `CLAUDE.md` §4 says malformed PDFs are normal and a qpdf repair pass should run when parsing fails. Without it a damaged file is simply refused.
- **Password protect / remove password.** pdf-lib cannot read *or* write encrypted PDFs.
- **Compress.** pdf-lib rewrites streams as it found them.

`docs/ARCHITECTURE.md` already names qpdf for this, so the decision is which build to take and what it drags in.

## Options

1. **`@neslinesli93/qpdf-wasm` 0.3.0** (ISC wrapper, qpdf 12.2.0). Typed, a plain Emscripten factory taking `locateFile`, no global mutation, 1.2 MB wasm. Ships no upstream licence text.
2. **`@jspawn/qpdf-wasm` 0.0.2** (Apache-2.0, ships qpdf's LICENSE). Its ESM wrapper assigns `globalThis.exports`, deletes it again, and reaches for `__dirname`/`require` — fragile inside a bundler and a module worker.
3. **Build qpdf ourselves** with Emscripten. Full control of provenance and of which codecs are linked in; a build toolchain to own and maintain.
4. **Do without.** Drop repair, encryption and compression from Phase 1. Not viable: repair is a stated requirement, and institutional documents arrive password-protected.

## Decision

**Option 1**, wrapped in `packages/core/src/qpdf.ts` behind a small interface (`repair`, `encrypt`, `decrypt`, `compress`). Option 2's wrapper would fight the bundler for a licence-text convenience we can satisfy ourselves; option 3 stays the answer if provenance has to be airtight before a paid release.

### What was measured, not assumed

- **qpdf version is 12.2.0**, which neither package declares; it came from `--version` at runtime.
- **The instance is reusable** across calls, so one module is created per worker and kept.
- **`--is-encrypted` is useless in this build**: it tries to open the file first, so it exits 2 both for "not encrypted" and for "encrypted and I have no password". There is therefore no `isEncrypted()` in our API — the engine's `PasswordRequiredError` is the signal.
- **qpdf's messages do not come back through the API.** The `print`/`printErr` module handlers are ignored by this build. Under Node nothing arrives at all; in the browser the messages do surface on `console` (a repair logs "can't find PDF header"), but only as console output, not as a value we can attach to an error. Error text is therefore derived from exit codes (2 = error, 3 = succeeded with warnings, which is what a successful repair looks like). Capturing `console` around `callMain` would recover the real text in the browser and is the obvious next improvement if users need better messages than "wrong password?". The messages name our own temporary file (`/in-0.pdf`), never the user's filename or any document content.
- **What repair actually fixes**, measured on generated damage: a mangled header ✅ (recovered in full), junk prepended before the header ✅, a `startxref` pointing at garbage ❌, a missing cross-reference table ❌, truncation mid-body ❌. So `repair()` throws for a good half of real-world damage, and callers must treat a throw as "still broken" rather than assume success. Phase 2 should revisit whether a stricter recovery pass (or `--qdf` style rebuilding) covers the xref cases.

### Consequences for the document model

pdf-lib cannot read encrypted files, so an encrypted document is **decrypted once on unlock** and the working copy kept in memory decrypted; the password is remembered and **re-applied on save**. Without that, opening a protected document and saving it would quietly strip its protection — a privacy regression, not just a surprise. The decrypted copy exists only in the worker's memory and is never written anywhere the user did not choose (privacy invariant 4).

The worker holds the bytes of a locked document until a password arrives, rather than the app re-sending them: `open()` transfers its buffer, which detaches the sender's copy.

## The licence question

qpdf is Apache-2.0 ✅ and zlib is Zlib ✅, both already allowed. But this wasm also links **libjpeg-turbo 2.1.1**, which is covered by **IJG AND BSD-3-Clause AND Zlib**, and the **IJG licence is not on our allow-list** — `docs/LICENSE-POLICY.md` says a new licence category needs this ADR.

The IJG licence is permissive and attribution-only: no copyleft, no field-of-use restriction, no advertising clause. It ships inside Chrome, Firefox and virtually every image pipeline. It requires that the origin of the software not be misrepresented and that the licence accompany the distribution.

**Decision: IJG is allowed for bundled binaries.** Accepted by the lab on 2026-10-16. The allow-list and the checker carry it, and `scripts/check-licenses.mjs` enforces it over `scripts/third-party.json` as well as over npm metadata.

If this is ever revisited, the fallback is a qpdf build without JPEG support (option 3) rather than dropping qpdf.

Two compliance obligations this created, neither satisfied by the npm metadata. Both are now discharged:

1. The package ships **no upstream licence text** for qpdf or libjpeg-turbo. The texts are fetched from upstream into `notices/` and assembled into `THIRD_PARTY_NOTICES.txt` by `pnpm notices`; `pnpm check:notices` fails in CI when the file is out of date. The generator refuses to write the file at all if any shipped component has no licence text, which is the breach the file exists to prevent.

   Getting the *version* right mattered: libjpeg-turbo's `main` branch says it is covered by **two** licences, while the **2.1.1** we actually link declares **three** (IJG, a modified BSD licence, and zlib). The notices carry the 2.1.1 texts.

2. Neither this package nor `@embedpdf/pdfium` declares the **version of the upstream project** it compiled. `scripts/third-party.json` records what runtime probing found, which is evidence, not provenance. Reproducing the builds ourselves remains the answer if provenance has to be airtight for a paid release.

One exception is recorded rather than papered over: `@neslinesli93/qpdf-wasm` itself publishes no licence file anywhere, only `"license": "ISC"` in its `package.json`. That declaration is the grant, and inventing a licence text with a copyright line we do not know would be worse than citing it, so the notices quote the declaration and `notices/declared-only.json` records the reason and the date it was checked. If a customer's legal review rejects a declaration-only dependency, `@jspawn/qpdf-wasm` ships qpdf's Apache-2.0 text and is the swap.

### A gap this closed

`pnpm check:licenses` read npm metadata only, so it saw "ISC" and was satisfied — it could never have seen libjpeg-turbo, because code compiled into a wasm blob has no package.json. The checker now also validates every component in `scripts/third-party.json` against the same allow-list. That file existed since ADR 0002 and **nothing had been enforcing it**; the first run caught one of its own entries carrying prose instead of an SPDX expression.

## Consequences

- Bundle grows by 1.2 MB of wasm (precached, so it costs first load only), fetched lazily: qpdf is only instantiated the first time a document needs repairing, unlocking, protecting or compressing.
- qpdf's wasm is fetched from a same-origin URL rather than handed over as bytes, because this build has no `wasmBinary` option. The URL is validated same-origin, mirroring the PDFium adapter.
- `repair()` failing is a normal outcome, not an exception to swallow; the UI shows a "Repaired" badge when a file was reconstructed, so the user knows the document was damaged.
- Protection state belongs to the open document, not to the save action. Any op that rewrites bytes keeps it.
