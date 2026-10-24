# Signet — FACTS-H Lab, IIIT Kottayam

**Privacy-preserving PDF editor from FACTS-H Lab, IIIT Kottayam.**

A complete PDF suite where your files never leave your computer. All viewing, editing, OCR, conversion and signing run on your device.

*Signet*: the seal ring that authenticates a document. The repo keeps its
codename, `pdf-suite`, and the packages stay `@pdf-suite/*`.

## Status

Phase 5 — parity. Most of Acrobat's English feature set is here.
`docs/ADOBE-PARITY.md` is the audited gap list, read from the code rather than
from memory; `docs/ROADMAP.md` is the phase checklist. The largest things still
missing are accessibility tagging, cryptographic signing (PKCS#11 / PAdES), and
the Windows and Linux desktop builds.

## Getting started (macOS)

```bash
brew install node pnpm          # Node 20+, pnpm 9+
# For the desktop shell:
# xcode-select --install && curl https://sh.rustup.rs -sSf | sh
```

## Try it

```bash
pnpm install
pnpm dev                 # http://localhost:5173
```

Drop a PDF onto the window, or click **Open**. Everything below runs on your
machine; the engine is a 4.4 MB WebAssembly build of PDFium, so the first load
takes a moment and the tools stay disabled until it says "Ready".

| What to try | What should happen |
| --- | --- |
| Drop a PDF on the window | Opens it; dropping again merges into the open document |
| Scroll a long document | Only the pages in view are rendered; the scrollbar still reflects the whole file |
| Click a thumbnail, then ↑ / ↓ | Selects a page and moves it. Drag thumbnails too |
| Select pages, **Delete** | Pages disappear from the view; nothing is written until you save |
| Select one page, **Insert after…** | A merged file's pages land after that page, not at the end |
| **Rotate left / right** | Rotates the selection, or the whole document when nothing is selected |
| Select pages, **Extract…** | Saves just those pages to a new file, leaving the open one alone |
| **Edit text**, then click a line | Type over the words in the document itself — not a note on top. Search and copy see the change. No reflow yet, so longer text runs past where the old text ended |
| **Highlight**, then drag across a line | A highlight snapped to the text lines you crossed. On a scan with no text layer it stays as you drew it |
| **Note**, then click a page | Asks for the text, then drops a sticky note. Hover it to read the note |
| **Add text**, then click a page | Asks for the words, then places them on the page |
| **Box**, **Oval**, **Draw**, and the colour dots | Shapes and freehand, in the chosen colour, written as real `/Square`, `/Circle` and `/Ink` annotations |
| **Marks** tab in the sidebar | Every annotation with its page; click to jump to it or remove it |
| Turn the tool off, click a mark | Removes it. **Clear N** removes every unsaved mark |
| **Save** after annotating | Marks become real PDF annotations — highlights, notes and free text that Acrobat and Chrome can edit, with the text under a highlight intact |
| **Underline** / **Strike**, then drag | The same snapping, written as real `/Underline` and `/StrikeOut` marks |
| **Redact**, drag over text, **Remove N areas** | Deletes the content, then re-reads the file to prove no text is left in those areas. The status line says so, or warns loudly if anything survived |
| **Form** tab in the sidebar | Lists the document's fields; fill them in and **Write values**. **Flatten** bakes them in so they cannot be changed. `p1` jumps to the field's page |
| **Bookmarks** tab in the sidebar | The document's outline, click an entry to jump. Says so plainly when a file has none |
| Select pages, **Split…** | Each selected page starts a new file; you get one save dialog per part |
| Zoom **Page** | Fits a whole page in the window |
| Type in **Search**, press Enter | Match count, ‹ › to step through, matched lines highlighted. Ctrl/Cmd+F focuses it |
| **Protect…**, set a password, **Save** | The saved file needs that password to open. Reopen it to be asked |
| **Compress** | Rewrites the document; object streams help on real files, not tiny ones |
| Zoom − / + / **Fit** | Pages re-rasterise at the new scale. Ctrl/Cmd with `-`, `=`, `0` also work |
| **From images…** or drop JPEG/PNG files | Builds a PDF, one page per image at its own aspect ratio |
| Select pages, **To images…** | Saves those pages as PNG files |
| **Clean up** checkbox next to OCR | Removes scanner speckle before reading the page. On by default: without it a noisy scan can come back completely empty. It does mean the saved page holds the cleaned image |
| Pick a language, **Recognise text** | OCRs scanned pages into searchable text. Pages that already have text are skipped. The language pack (1–5 MB) downloads from this app's own origin on first use |
| **Save** | Native save dialog where available, a download otherwise |

### Testing the privacy claim

```bash
pnpm build && pnpm preview     # http://localhost:4173
```

Load it once, then turn off Wi-Fi (or use the browser's offline toggle) and
reload. Everything above keeps working, including opening and saving files. The
browser's network panel should show no request to any host but localhost — that
is what `pnpm e2e` asserts on every run.

### Known gaps, so you are not hunting for them

`docs/ADOBE-PARITY.md` is the audited list. These are the ones that bite:

- **A mark cannot be edited after placing** — remove it and place it again.
- **Search highlights a whole line**, not the matched word. Narrowing it needs
  per-character geometry from the engine (ADR 0002).
- **Repair on open** fixes a damaged header or junk before it, but not a
  destroyed cross-reference table or a truncated file (ADR 0003).
- **Indic extraction is verified on born-digital documents only** — 40 real
  Malayalam files from Kerala LSGD and the Kerala Assembly. OCR on real Indic
  *scans* is still unmeasured, and so is Hindi.
- **OCR needs language data present.** Run `node scripts/fetch-tessdata.mjs`
  once; it lands in a git-ignored `vendor/` that dev, preview and builds serve
  from. A release has to host these files (ADR 0004).
- **OCR replaces a recognised page with an image plus an invisible text layer**
  at 300 dpi, so a recognised page is re-encoded. Pages that already have text
  are skipped untouched. Despeckling is on by default; there is no deskew.
- **Forms are filled from the side panel**, not by clicking the fields on the
  page. The builder can draw fields; filling still happens in the panel.
  XFA-only forms are not supported and say so.
- **Redaction removes whole text runs** that overlap the area, not just the
  characters inside it — safer, but it can take neighbouring words with it. The
  count is reported so you can see what happened.
- **Signing is a panel, not a signature.** It reports who signed, when, and
  whether anything was appended after. Making a signature needs PKCS#11 and is
  specified, not built (ADR 0006).
- **PDF/A is checked, not converted** (ADR 0008), and there is **no
  accessibility tag tree**, so no PDF/UA.
- **PDF → Word carries the text and the tables, not the layout.**
- Rendered pages are not cached between zoom levels, so zooming a 500-page
  scan re-rasterises as you scroll.
- The desktop shell is built and run on **macOS**; Windows and Linux are built
  by the release workflow but have never been opened by anyone.
- **The OCR language data is not pinned.** `fetch-tessdata.mjs` pulls from the
  `main` branch of `tesseract-ocr/tessdata_fast` with no digest check, so two
  releases can carry different bytes under the same version. ADR 0004 says a
  release must pin them; it does not yet.

## Testing against your own documents

```bash
pnpm corpus:samples   # fetch a starter corpus: real public-domain Malayalam and
                      # Hindi government PDFs, plus generated edge cases
pnpm corpus:lsgkerala # 25 real Malayalam PDFs from Kerala LSGD (robots.txt-respecting)
pnpm corpus           # open, render, round-trip and re-open every file
pnpm corpus --ocr mal,eng   # also OCR any page that has no text layer
pnpm bench:engines    # PDFium vs pdf.js over the same files (ADR 0002)
```

The department's circulars portal (`go.lsgkerala.gov.in`) is **not** crawled: its
robots.txt disallows `/files`, where its documents live. Download those by hand if
you need them.

Add your own documents to `corpus/` as well — that is what the gate is for.
`corpus/PROVENANCE.json` records where each file came from and under what
licence. Nothing in `corpus/` is ever committed.

Each file is opened (with the repair fallback), page 1 rendered, text
extracted, and the document round-tripped and re-opened. It prints counts,
timings and failure messages — never a filename, and never document content.
A second run fails if a file that previously worked no longer does, and the
baseline only moves on a clean run or with `--accept`.

This is the corpus gate, and the same corpus is what ADR 0002 (engine choice)
and ADR 0004 (OCR accuracy) are waiting on.

## Desktop (Tauri)

```bash
pnpm desktop:info    # needs Rust: curl https://sh.rustup.rs -sSf | sh
pnpm desktop         # the same UI in a native window
```

Builds and runs on macOS, with native open and save dialogs. The shell has no
HTTP permission at all, so it cannot make a network call even by accident.
Windows and Linux have a CI job but have not been built yet.

## Releases

```bash
node scripts/check-version.mjs 0.1.0   # the five manifests must agree
# then bump them all, commit, and:
git tag v0.1.0 && git push --tags
```

The tag triggers `.github/workflows/release.yml`, which builds the PWA and the
macOS, Windows and Linux bundles, checksums them and publishes a GitHub release.
A manual run of the same workflow builds everything and publishes nothing, which
is how to prove the pipeline without spending a version number.

Each build carries the OCR language data for English, Malayalam and Hindi
inside it — the desktop shell has no HTTP permission and the web app's CSP is
`connect-src 'self'`, so neither can fetch a language pack from anywhere but
its own origin. That is why the downloads are large.

Nothing is code-signed yet, so macOS and Windows warn on first open. `SHA256SUMS`
in the release is the only integrity claim a release can honestly make today.

### The public trial

```bash
SIGNET_TRIAL=1 pnpm build                  # the same app, minus writing a file
SIGNET_TRIAL=1 pnpm exec playwright test trial.spec.ts
```

`.github/workflows/trial.yml` builds it, proves it refuses to hand a file over
and still works with the network cut, and only then publishes it to GitHub
Pages. The restriction is one guard in `saveBytes` and one in `printBytes` —
every path that writes a file for the user goes through those two.

It is a sign on a door, not a lock. The app runs entirely in the browser, so
anyone who opens the developer tools can defeat it. It exists to send an
interested visitor to the installer, not to stop a determined one.

## Licences

```bash
pnpm check:licenses   # fails on a non-allow-listed licence, npm or bundled
pnpm notices          # regenerates THIRD_PARTY_NOTICES.txt
pnpm check:notices    # fails if that file is stale (runs in CI)
```

`THIRD_PARTY_NOTICES.txt` is generated and committed. It covers the npm
production dependencies and the components compiled into our WebAssembly
builds, which npm cannot see — qpdf, PDFium, libjpeg-turbo, zlib, Tesseract and
its language data. Upstream texts that a package does not ship are committed
under `notices/`, pinned to the version we link.

## Docs
- `CLAUDE.md` — rules for Claude Code (privacy, licences, conventions)
- `docs/PRODUCT.md` — who it's for and why it wins
- `docs/ARCHITECTURE.md` — zero-upload design and package layout
- `docs/ROADMAP.md` — phases and checklists
- `docs/PRIVACY.md` — what may and may not cross the network
- `docs/LICENSE-POLICY.md` — dependency allow-list
- `docs/adr/` — architecture decision records
