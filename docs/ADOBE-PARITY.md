# Parity with Adobe Acrobat — what we have and what is missing

The decision recorded in `docs/ROADMAP.md` is to reach feature parity in **English
first**, then extend to Malayalam, Hindi and other Indian languages. This file is
the concrete list that "parity" means, so it is a checklist rather than a feeling.

Scope note: Acrobat Pro is twenty-five years of features and some of them are
Acrobat-specific (cloud storage, Sign subscriptions, Document Cloud). Those are
explicit non-goals in `docs/PRODUCT.md` — zero-upload is the point of this product
— so they are listed as "will not do" rather than as gaps.

## Interface

Laid out the way Acrobat is, because that is what people arrive knowing: a
minimal top bar (open, save, search, document name), a left sidebar with Pages,
Marks, Form and Bookmarks tabs, the document in the middle, a right-hand panel of
tools grouped by task, and zoom plus status along the bottom. Tools are a grid of
labelled buttons with the active one held down, and the colour choice sits with
them rather than in the top bar.

What is still cruder than Acrobat: no contextual toolbar on a selected mark, no
properties panel, no right-click menus, and the tools panel hides below 980 px
instead of collapsing to icons.

## Have, in English and already tested

| Acrobat feature | Here |
| --- | --- |
| View, zoom, fit, page thumbnails | Viewer with virtualised pages, fit-width, fit-page, zoom controls |
| Bookmarks panel | Sidebar tab, click to jump |
| Find in document | Search with per-page progress, match count, highlights |
| Combine files | Merge, and insert at a chosen position |
| Organize pages | Reorder (drag or keyboard), rotate, delete, extract, split |
| Comment: highlight, underline, strike-through, sticky note, text box | All five, written as real PDF annotations |
| Drawing markup: freehand, rectangle, oval | Ink, Square and Circle, with a colour palette |
| Comments list | Marks panel: every annotation with its page, click to jump or remove |
| Protect with a password | AES-256 via qpdf; protection survives editing and saving |
| Reduce file size | Recompress via qpdf |
| Scan to searchable PDF | Tesseract OCR with an invisible text layer |
| Fill and sign (fill part) | AcroForm filling, with flattening |
| Redact | True content removal, with a verification pass |
| Export pages as images | PNG per page |
| Create PDF from images | JPEG and PNG, one page per image or fitted |
| Repair a damaged file | qpdf repair pass on open |
| Edit PDF (text) | Click a paragraph and type over it; it re-wraps to its own width, and a font with no glyph for what was typed is substituted |

## Missing for English parity, in the order I would build it

1. **Edit text and images in place** — Acrobat's "Edit PDF". **Text done;
   images not.** Clicking a paragraph and typing over it changes the words in the
   content stream, keeping font, size, colour and position. The block re-wraps to
   its own width: lines that already exist are reused, lines the new text needs
   are added, surplus ones removed. Search, extraction and copy all see the new
   text, and nothing is drawn over the old.

   Paragraph detection is a heuristic — runs that share a left edge, a size and a
   line spacing — so the editor outlines the block it found before anything is
   typed, which makes a wrong guess (tables, columns) visible rather than
   surprising.

   Font substitution: a character the document's font has no glyph for is set in
   Helvetica instead, for the whole block, and the swap is reported in the status
   line. A character no standard font can draw (an emoji, say) is refused rather
   than written as empty boxes.

   What Acrobat still does that this does not:
   - **Push content aside.** A block that grows lays its extra lines below itself
     and can overlap what follows; the status line says how many lines were
     added. Acrobat behaves the same way.
   - **Match the substituted font.** Acrobat looks for a system font resembling
     the original; we always use Helvetica, because a font the user has is not a
     font the next reader has.
   - **Mixed fonts in one block.** Substitution replaces the whole paragraph's
     font, not only the characters that needed it.
   - **Images.** Moving, resizing and replacing images in place is untouched.
   - **Adding a new paragraph** in the document's own font, as opposed to a text
     annotation.
2. **Digital signatures** — sign, certify, and a validation panel. Phase 3; needs
   the signing-library ADR and, on desktop, PKCS#11 for USB tokens.
3. **Comment workflow** — the list and colours are done; what remains is reply
   threads and a resolved state (`/IRT` and `/RT` on the annotation), plus
   import/export of annotations (XFDF).
4. **Lines, arrows, callouts and stamps** — freehand, boxes and ovals are done.
   Lines and arrows wait on `/AP` generation, because PDFium does not synthesise
   an appearance for `/Line`: the annotation would be in the file and invisible
   in our own viewer.
5. **Form builder** — create and name fields, set tab order, validation; today
   only existing fields can be filled.
6. **Export to Word, Excel, PowerPoint** — Phase 4 lists PDF → Word/Excel as beta.
7. **Compare two documents** — text and visual diff. Phase 3.
8. **PDF/A and PDF/UA** — conversion and validation, plus accessibility tagging
   and a reading-order editor. Phases 3 and 5.
9. **Office → PDF** — desktop only, via LibreOffice. Phase 2, and blocked on the
   desktop shell actually building: it is scaffolded but has never been compiled.
10. **Page-level polish** — crop, headers and footers, watermarks, Bates
    numbering, page labels, background.
11. **Attachments and portfolios** — embedded file attachments.
12. **Print production** — preflight, colour separations, ink manager. Niche for
    institutional use; low priority.
13. **Action wizard / batch** — Phase 4 covers the institutional version (grade
    cards from templates and CSV).

## Will not do, deliberately

Cloud storage and sync, shared review hosted by us, online sharing links,
real-time collaboration, and anything that uploads a document. These are what
`docs/PRODUCT.md` trades away on purpose: the product's claim is that files never
leave the device, and that claim is worth more to a university than feature
parity on items that require a server.

## How to use this list

Items 1–5 are what an institutional user notices first. Items 10 and 11 are cheap
and visible, so they are good candidates whenever a bigger item stalls. Nothing
here is blocked on Indic support, which is the point of the English-first
decision — but note that the OCR and search work already handles Malayalam, so
"English first" means "do not wait for Malayalam scans", not "remove it".
