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
| Type in **Search**, press Enter | Match count, ‹ › to step through, matched lines highlighted. Ctrl/Cmd+F focuses it |
| **Protect…**, set a password, **Save** | The saved file needs that password to open. Reopen it to be asked |
| **Compress** | Rewrites the document; object streams help on real files, not tiny ones |
| Zoom − / + / **Fit** | Pages re-rasterise at the new scale. Ctrl/Cmd with `-`, `=`, `0` also work |
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
- No annotation, no form filling, no outline/bookmarks panel, no OCR yet.
- Rendered pages are not cached between zoom levels, so zooming a 500-page
  scan re-rasterises as you scroll.

## Docs
- `CLAUDE.md` — rules for Claude Code (privacy, licences, conventions)
- `docs/PRODUCT.md` — who it's for and why it wins
- `docs/ARCHITECTURE.md` — zero-upload design and package layout
- `docs/ROADMAP.md` — phases and checklists
- `docs/PRIVACY.md` — what may and may not cross the network
- `docs/LICENSE-POLICY.md` — dependency allow-list
- `docs/adr/` — architecture decision records
