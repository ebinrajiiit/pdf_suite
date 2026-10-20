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

Sixty-odd actions no longer fit in a panel someone can scan, so ⌘K opens a
palette that searches every one of them by name, group and a few extra words —
"shrink" finds Compress — and ? lists the keys. The tool groups collapse, and
what a reader collapses stays collapsed. Only one panel is open at a time:
they are strips above the document, and two at once pushes the document off the
screen.

Editing text shows a format bar over the block being edited — typeface, size,
colour, how many lines — because the typeface you are typing into should not be a
guess. The size and the face are live: changing either rebuilds the block in that
format and re-wraps it. The faces offered are the PDF standard set, since those
draw everywhere without embedding anything; the document's own font stays the
default, because it may be a face no standard font resembles.

The tools panel can be put away, which gives the document the whole window, and
brought back from the top bar or the palette. A narrow window starts without it:
it used to disappear below 980 px with no way to ask for it again.

Long jobs say how far they have got — "Reading text — page 112 of 500" with a
bar — and can be given up on: Stop sits in the status line while anything is
running, and stopping is not an error, so nothing is reported as one. OCR and
the rest give up at a page boundary rather than inside a page, so Stop on a
500-page scan takes as long as the page in hand.

Undo and redo sit next to Open and Save, and cover both kinds of change: the
page order and the marks you have placed, which live in the app until something
writes them into the file, and the document's bytes, whose history the worker
keeps because it already holds every version. It is bounded — twenty steps, or
256 MB of them, whichever comes first, since a step of a 200 MB scan costs 200 MB.

Right-clicking a page, in the panel or in the document, offers what can be done
to it: rotate, insert, extract, save as an image, delete. Keyboard: ⌘O, ⌘S, ⌘Z,
⇧⌘Z, ⌘F, ⌘+/−/0 and Delete for the selected pages.

What is still cruder than Acrobat: no contextual toolbar on a selected mark, no
properties panel for annotations, no right-click menu on a mark or on selected
text, and the tools panel hides below 980 px instead of collapsing to icons.

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
| Comments list | Marks panel: the document's own marks and the ones placed here, with author, searchable and removable |
| Protect with a password | AES-256 via qpdf; protection survives editing and saving |
| Reduce file size | Recompress via qpdf |
| Scan to searchable PDF | Tesseract OCR with an invisible text layer |
| Fill and sign (fill part) | AcroForm filling, with flattening |
| Redact | True content removal, with a verification pass |
| Export pages as images | PNG per page |
| Create PDF from images | JPEG and PNG, one page per image or fitted |
| Repair a damaged file | qpdf repair pass on open |
| Add header and footer | Six slots, with tokens for page number, page count, date and file name; size, margin, start number, numbering style, and a page range |
| Bates numbering | A prefix and zero-padding on the same page-number token — `ACME-{n}` padded to 6 is `ACME-000001` |
| Undo and redo | Both, over page order, marks and the document's bytes, with ⌘Z and ⇧⌘Z |
| Right-click a page | Rotate, insert, extract, export, delete, in the panel and on the page |
| Edit PDF (text) | Click a paragraph and type over it; it re-wraps to its own width, and a font with no glyph for what was typed is substituted |

## What is missing, audited against Acrobat's own tool list

Checked on 2026-10-20 against Adobe's documentation (the Standard/Pro comparison,
the Acrobat features page, and the help topics for preflight, accessibility,
forms, comments, page tools, signatures, sanitising and the Action Wizard) rather
than from memory. Status is what this repository actually does, read from the
code: the worker's operation list, `packages/core`'s exports and the engine's
interface.

### The first hour

What an Acrobat user would miss before anything subtle:

| Missing | Why it bites | What it needs |
| --- | --- | --- |
| ~~Print~~ | **Done.** ⌘P opens the document, marks and all, in the browser's own PDF viewer — vector, not a rasterised copy. The desktop shell has no print dialog in its webview, so it hands the file to the system viewer instead | |
| ~~Select and copy text~~ | **Done.** A transparent text layer over each page, laid out from the runs the engine extracts, so selection, copy and the browser's own find all work on real text | |
| ~~Edit images in place~~ | **Done.** Drag to move, corner to resize, buttons to replace or remove — the frame stays where it is | |
| ~~A signature you can draw~~ | **Done.** Draw it once, kept in this browser only, then click any page to place it. A drawn mark, not a digital signature | |
| ~~Lines and arrows~~ | **Done**, with generated appearance streams — verified by rendering, not just by writing the dictionary | |
| ~~Stamps~~ | **Done**: eight labels, drawn into an appearance stream. Dynamic stamps (name, date) would be template text on the same machinery | |
| ~~Bookmarks you can edit~~ | **Done.** Add one for the page you are reading, rename it in place, move it among its siblings, remove it with its branch | |
| ~~Document properties~~ | **Done.** ⌘D reads and rewrites title, author, subject and keywords. XMP is still untouched | |

### Create

| Acrobat | Here |
| --- | --- |
| From file (Office, images, text, HTML) | Images, and Office on the desktop through the machine's own LibreOffice (ADR 0007 — detected, not bundled). The browser build says it cannot and why. HTML and plain text are missing |
| From scanner | Done on the desktop where the machine offers an interface: SANE's `scanimage` (standard on Linux, Homebrew on macOS) and WIA through PowerShell on Windows. The button is hidden where neither exists. macOS without SANE has no driveable interface at all |
| From web page (Web Capture) | Missing, and in tension with the privacy invariants: fetching a page is a network call. It would need its own ADR |
| From clipboard, blank page | Missing. Both are small |
| Combine files | Merge and insert-at-position are done |
| PDF Portfolio | Missing. A portfolio is a container document with an embedded file tree and a Flash-era navigator; the sane subset is "embedded files with a list view" |
| PostScript → PDF (Distiller) | Missing, and likely permanent: the usable interpreters are Ghostscript (AGPL) and MuPDF, both banned by `docs/LICENSE-POLICY.md` |

### Edit and organise

| Acrobat | Here |
| --- | --- |
| Edit text | Done, with paragraph reflow and font substitution |
| Edit images | Move, resize, remove, replace — with the frame kept exactly where it was — and turn a quarter at a time about the centre of the box, composed onto the matrix the picture already has so four turns land exactly where it started. Cropping a picture is missing |
| Add a new paragraph in the document's own font | Missing. A text annotation is not the same thing |
| Crop pages | Done: drag what to keep, on the selection or every page, and put it back again. It says in the panel that cropping hides rather than removes |
| Watermark and background | Text watermarks, behind the content or over it, with fade and angle. Behind means a prepended content stream, which is the only way to be underneath. Image watermarks are missing |
| Headers, footers, page numbers, Bates | Done |
| Page labels (`/PageLabels`) | Done: runs of pages numbered 1,2,3 or i,ii,iii or a,b,c, each with a prefix, which is what the viewer's page box reads |
| Rotate, reorder, insert, extract, delete, split | Done |
| Replace pages | Missing, though it is delete + insert |
| Links | Draw a box and point it at a page or a web address; a reader follows it, and a web address is never opened on the document's say-so. With the Link tool in hand, clicking an existing link changes or removes it instead of following it |
| Bookmarks | Add, rename, move, nest under another or lift back out, and remove — written as a real `/Outlines` tree |
| Named destinations | Written and read, sorted as a name tree has to be. Pointing a bookmark at one is missing |
| Attachments (embedded files) | Done: attach, list, extract and remove, in a panel of their own. Sanitising removes them, which is the same feature read the other way |
| Attach a file as a comment | Done: pin a file to a point on a page as a `/FileAttachment` with a drawn icon, so the annexure is marked beside the clause that refers to it rather than only in a panel |
| Layers (OCG) | A panel that lists them and turns them on and off, which is what a drawing needs before it goes to a contractor. Flattening a layer away is missing; Remove hidden info is what takes one out |
| Article threads | Missing. Rare outside journals |
| Rich media (video, audio, 3D, buttons) | Missing, and 3D is not worth it |
| Optimise (PDF Optimizer) | qpdf recompresses streams, and pictures stored at more resolution than they are printed at are re-encoded smaller. Font subsetting and a space audit are missing |

### Export

| Acrobat | Here |
| --- | --- |
| PDF → Word | The document's **text**, as a real .docx: a paragraph per paragraph — found by the same block detection in-place editing uses, so a wrapped paragraph arrives as one editable paragraph rather than one per line — at roughly its own size, bold where the font is bold, a page break per page, the PDF's own page size and orientation — a landscape annexure gets a section of its own, since a section is the only thing in Word that carries a page size — and a Word table where the page really is a grid, with the heading above it left as a heading. Not the layout: no columns, no images, no positioning, because a PDF records where ink goes and reconstructing the rest is guesswork. The export says so in the status line. Excel, PowerPoint and RTF are missing; the licence trap stands — `pdf2docx` pulls PyMuPDF and is banned |
| PDF → plain text | Done, in display order with a page break and number per page |
| PDF → spreadsheet | Grid tables — rows and columns that line up — found and saved as CSV, which Excel opens. Merged cells, nested tables and columns implied only by a change of font are not found, and a page with no table says so rather than producing a spreadsheet that looks right and is not |
| PDF → HTML, XML | Missing |
| PDF → images | Done (PNG) |
| PDF/A check | Done, as a report: encryption, fonts not embedded, no XMP, no output intent, JavaScript. Conversion is not done — it means embedding every font and an ICC profile, and a tool that says "converted" without both has produced a file that fails validation later, somewhere else. PDF/X and PDF/E are untouched |

### Comment and review

| Acrobat | Here |
| --- | --- |
| Sticky note, highlight, underline, strike-through, text box | Done |
| Insert/replace text markup (caret) | The caret is done, carrying what should be inserted |
| Callout | Done: click what it points at, type, and the box sits above it with a kneed line |
| Line, arrow | Done, with their own appearance streams |
| Polygon, polyline, cloud | Done: click each corner, double-click to finish. The cloud draws its own bumps rather than trusting a reader to honour `/BE` |
| Rectangle, oval, pencil | Done |
| Eraser for ink | Missing |
| Stamps | Fixed labels and dynamic ones — {date} and {name} are filled in as the stamp is placed — and a stamp made from a picture: an office seal, a scanned signature or a logo, drawn into the appearance stream at the proportions of the picture |
| Attach a file or audio as a comment | Missing |
| Comment opacity, default properties, author name | Colour only |
| Replies, status (accepted, rejected, completed) | Done, as `/IRT` with `/RT` — a reply is `R`, a status is a `Group` reply carrying `/State`, which is what Acrobat writes and reads. Threads are shown nested |
| Comment list: filter, sort, search, summarise | All four: filtered by kind, searched by text, sorted by page, and summarised as a list of who said what on which page, replies and review states included |
| Import/export comments (XFDF) | Done, both ways. What cannot be drawn is counted and left out rather than approximated. FDF, the older binary-ish form, is not read |
| Shared review, Send for comment | Will not do — it uploads |
| Measuring tools (distance, perimeter, area, scale, snap) | Missing. Engineering and architecture drawings need these |

### Forms

| Acrobat | Here |
| --- | --- |
| Fill in fields, flatten | Done (text, checkbox, radio, dropdown, button, signature read) |
| Create and edit fields | Create: done, for text boxes, tick boxes and dropdowns — drag where the field goes and name it. Editing a field's size or kind after the fact is missing; remove and draw it again |
| Automatic field recognition | Missing |
| Tab order | Follows the order fields are created, which is what a reader uses when the page has no explicit `/Tabs`. Setting it by hand is missing |
| Calculations and validation | Done, without document JavaScript: a small expression language — numbers, the four operators, brackets, field names, sum/avg/min/max — stored on the field and computed here. Another reader will not recompute, so the totals are written into the fields when the form is filled. Formatting scripts are missing |
| Barcode fields | Missing |
| Fill a form from a spreadsheet | Done: a template and a CSV give one filled, flattened document per row — grade cards, certificates, hall tickets. Columns match fields through the punctuation in field names, and a column with no field is reported rather than dropped |
| Distribute, collect, track responses | Missing. The local half — export and merge FDF — is compatible with zero upload; the tracker is not |
| XFA dynamic forms | Detected and reported, never rendered. Acrobat is retiring XFA too |

### Protect

| Acrobat | Here |
| --- | --- |
| Password encryption | Done, AES-256 via qpdf |
| Permissions (printing, copying, editing) separately from opening | Done: printing, copying and changes, set with the password. The panel says what they are — a request the reader honours, not a lock |
| Certificate encryption | Missing |
| Security policies | Missing |
| Redact | Done, with true content removal and a verification pass |
| Mark for redaction, then apply | Done: marks are `/Redact` annotations written into the file, so the clerk who marks need not be the registrar who applies. Removing immediately is still there for when nobody needs to review |
| Find text or patterns and redact all | Done: Aadhaar, PAN, phone and email, plus any words. Matches are counted and sampled before anything is destroyed |
| Redaction codes and overlay text | Done: the code is printed in the box, sized to fit it |
| Sanitise / remove hidden information | Done for the description, XMP, embedded files, scripts and actions, with comments and links optional. Hidden layers and deleted-but-present content are still missing |

### Sign

| Acrobat | Here |
| --- | --- |
| Fill & Sign: draw a signature | Done. Typing one, in a handwriting face, is missing |
| Certificate-based signature | Specified in ADR 0006 and not built: signpdf + node-forge for a software certificate, the `cryptoki` crate for USB DSC tokens on the desktop |
| Certify (visible or hidden) | Missing |
| Validate signatures, trust, signature panel | A panel that reads what the document says — who signed, when, why, and whether anything was appended after signing, which is the abuse that matters. It does not check the certificate chain and says so (ADR 0006) |
| Timestamp (RFC 3161), LTV | Missing. The timestamp call is already allowed by the privacy invariants — it sends only a hash |
| Digital ID management | Missing |
| Compare signed version to current | Missing |
| Send for e-signature | Will not do — it uploads |

### Scan and recognise

| Acrobat | Here |
| --- | --- |
| OCR to searchable PDF | Done (English, Malayalam, Hindi) |
| Enhance scans: despeckle | Done |
| Deskew, sharpen, background removal, auto-contrast | Missing. Measured in ADR 0004: speckle was the failure mode, skew was not, so this is lower value than it looks |
| Recognise text in several files at once | Missing — batch |
| Scanner acquisition | Missing — see Create |

### Accessibility

| Acrobat | Here |
| --- | --- |
| Accessibility Check | Done, for the checks with an unambiguous answer: title, language, tagging, window title, pages with no text, pictures with no description |
| Set the title, language and window title | Done, from the same panel |
| Autotag | Missing — see above. The tag tree is a second document structure to build and edit |
| Reading Order tool, Tags panel, table editor | Missing, and all downstream of tagging |
| Alternate text on pictures | Missing: descriptions live in the tag tree |
| PDF/UA validation | Missing. veraPDF is Apache-2.0, so it is allowed |
| Read Out Loud, reflow view | Missing |

### Print production (Acrobat Pro)

| Acrobat | Here |
| --- | --- |
| Preflight | A print check: fonts not embedded, images below 300 DPI at the size they are printed, and a missing trim box. Profiles and fixups are missing |
| Trim box | Can be set, inset by a bleed |
| Output preview, separations, ink manager | Missing, and out of reach with PDFium's wasm build: they need the renderer's own colour pipeline |
| Colour conversion, transparency flattening, trap presets, printer marks | Missing |

### Everything else

| Acrobat | Here |
| --- | --- |
| Compare two documents | Text comparison, page by page, with the words that went and the words that arrived. Pages are paired by position, not matched up, and the panel says so. A visual diff is missing |
| Action Wizard (batch) | A sequence of steps over many files — each step works on what the last produced — plus filling a form once per spreadsheet row. Each file is saved as a new document and a failure does not stop the rest. A sequence can be named and kept, in this browser, so next week's run is one click |
| Catalog: full-text index across many files | Missing |
| Search across several files | Missing — one document at a time |
| View modes | Continuous, two-up and single page, with the page box as the way through the document, and full screen. Split view is missing |
| Print: booklets, posters, scaling, print comments, print a range | Missing — printing hands the whole document to the platform's viewer, which brings its own dialog |
| Snapshot tool, rulers, guides, grid | Missing |
| Geospatial PDF | Missing |
| Document JavaScript | Will not do — see below |

## Will not do, deliberately

Cloud storage and sync, shared review hosted by us, online sharing links,
real-time collaboration, and anything that uploads a document. These are what
`docs/PRODUCT.md` trades away on purpose: the product's claim is that files never
leave the device, and that claim is worth more to a university than feature
parity on items that require a server.


Two more, on the same principle:

**Document JavaScript.** Acrobat runs JavaScript embedded in a PDF: form
calculations, validation, auto-fill, and historically a long line of exploits.
Running a document's own code on a machine holding student records is a bad
trade for the convenience of a calculated field. Form calculations can be done
instead by our own code over the field values, with no script from the file ever
executing.

**The AI features.** Acrobat Studio's summaries, chat and generative edits all
send the document to Adobe. `docs/PRODUCT.md` Phase 4 keeps the idea and moves
the model onto the device — if it cannot run locally, it does not ship.

## How to use this list

The first-hour table is the order to work in: those eight are what makes the
difference between a tool someone tries and a tool someone switches to. After
them, three things are worth more than their position in Acrobat's own menus
suggests, for an institution specifically:

1. ~~Find-and-redact by pattern~~ — **done.** Aadhaar, PAN, phone and email
   patterns plus any words, found across every page with boxes from PDFium's
   per-character geometry, counted for review, then removed through the
   verified redaction pass.
2. ~~Sanitise / remove hidden information~~ — **done.** The description, the
   XMP packet, embedded files, document scripts and actions on fields, with
   comments and links as options. It reports what it found before removing it.
3. **Accessibility** — the check is **done**: title, language, tagging, window
   title, scanned pages with no text, pictures with no description, each with
   what it means for a reader. The title, the language and the window-title
   flag are fixed on the spot. **Tagging is still missing**, and is the rest of
   this: it means deciding what is a heading, what is a table and in what order
   a document should be read, from nothing but coordinates. Acrobat guesses and
   tells you to check every tag afterwards; claiming to have done it would be
   worse than saying it is not done.

Nothing here is blocked on Indic support, which is the point of the English-first
decision — but note that OCR and search already handle Malayalam, so "English
first" means "do not wait for Malayalam scans", not "remove it". The one place
the language question is now blocking is headers, footers and the text editor's
font substitution: both are limited to the PDF standard fonts, so neither can set
Malayalam. Embedding a Unicode font is the single change that fixes both.
