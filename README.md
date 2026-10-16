# PDF Suite (codename) — FACTS-H Lab, IIIT Kottayam

A complete PDF suite where your files never leave your computer. All viewing, editing, OCR, conversion and signing run on your device.

## Status
Phase 1 — view and organize. See `docs/ROADMAP.md` for what is done and what is not.

## Getting started (macOS)

```bash
# Prerequisites
brew install node pnpm          # Node 20+, pnpm 9+
# Later, for the desktop app (Phase 2):
# xcode-select --install && curl https://sh.rustup.rs -sSf | sh

git init && git add . && git commit -m "Project scaffold"
claude                          # start Claude Code in this folder
```

Then paste the prompt from `KICKOFF.md` into Claude Code.

## Try it

```bash
pnpm install
pnpm dev                 # http://localhost:5173
```

Drop a PDF onto the window, or click **Open**. Everything below runs on your
machine; the engine is a 4.4 MB WebAssembly build of PDFium, so the first load
takes a moment and the toolbar stays disabled until it says "Ready".

| What to try | What should happen |
| --- | --- |
| Drop a PDF on the window | Opens it; dropping again merges into the open document |
| Scroll a long document | Only the pages in view are rendered; the scrollbar still reflects the whole file |
| Click a thumbnail, then ↑ / ↓ | Selects a page and moves it. Drag thumbnails too |
| Select pages, **Delete** | Pages disappear from the view; nothing is written until you save |
| Select one page, **Insert after…** | A merged file's pages land after that page, not at the end |
| **Rotate left / right** | Rotates the selection, or the whole document when nothing is selected |
| Select pages, **Extract…** | Saves just those pages to a new file, leaving the open one alone |
| **Highlight**, then drag across a line | A highlight snapped to the text lines you crossed. On a scan with no text layer it stays as you drew it |
| **Note**, then click a page | Asks for the text, then drops a sticky note. Hover it to read the note |
| **Add text**, then click a page | Asks for the words, then places them on the page |
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

- **Annotations cannot be edited after placing** — remove and place again. No
  colour picker, no underline/strike/freehand yet, and no `/AP` appearance
  streams, so a viewer that does not synthesise appearances (PDFium, pdf.js and
  Acrobat all do) would show nothing.
- **Search highlights a whole line**, not the matched word. Narrowing it needs
  per-character geometry from the engine (ADR 0002).
- **Repair on open** fixes a damaged header or junk before it, but not a
  destroyed cross-reference table or a truncated file (ADR 0003).
- **Indic text** has tested *matching* (normalisation forms) but no verified
  *extraction* from real Malayalam or Hindi documents — that needs the corpus.
- **OCR needs language data present.** Run `node scripts/fetch-tessdata.mjs`
  once; it lands in a git-ignored `vendor/` that dev, preview and builds serve
  from. A release has to host these files (ADR 0004).
- **OCR replaces a recognised page with an image plus an invisible text layer**
  at 300 dpi, so a recognised page is re-encoded. Pages that already have text
  are skipped untouched.
- OCR accuracy on real scans is unmeasured — ADR 0004's numbers come from
  generated images. No deskew or despeckle yet, which is where scanned accuracy
  is usually won.
- **Forms are filled from the side panel**, not by clicking the fields on the
  page — the widget geometry is available, so overlaying the inputs is a
  follow-up. XFA-only forms are not supported and say so.
- **Redaction removes whole text runs** that overlap the area, not just the
  characters inside it — safer, but it can take neighbouring words with it. The
  object count is reported so you can see what happened.
- No desktop app, and no Office→PDF, yet.
- Rendered pages are not cached between zoom levels, so zooming a 500-page
  scan re-rasterises as you scroll.

## Testing against your own documents

```bash
# Put real PDFs in corpus/ (never committed), then:
pnpm corpus
```

Each file is opened (with the repair fallback), page 1 rendered, text
extracted, and the document round-tripped and re-opened. It prints counts,
timings and failure messages — never a filename, and never document content.
A second run fails if a file that previously worked no longer does, and the
baseline only moves on a clean run or with `--accept`.

This is the Phase 1 gate, and the same corpus is what ADR 0002 (engine choice)
and ADR 0004 (OCR accuracy) are waiting on.

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
