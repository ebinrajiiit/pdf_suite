# Signet — product description

**FACTS-H Lab, Indian Institute of Information Technology, Kottayam**

---

## Tagline

> **Privacy-preserving PDF editor from FACTS-H Lab**

Used verbatim in the installed app's description, the desktop installer, the
page's meta description, the welcome screen and About. `apps/web/src/brand.test.ts`
holds those surfaces to one wording.

The supporting line, wherever there is room for a second: *your files never
leave your computer.*

## One line

A complete PDF suite where your files never leave your computer.

## What it is

Signet does what Adobe Acrobat does — read, edit, annotate, reorganise, OCR,
redact, convert, fill, sign and check a PDF — with one difference that governs
every other decision in it: **the document never goes anywhere.** There is no
server to upload to, no account to make, no telemetry, no crash reporter, no
CDN, no web font. The whole engine is compiled to WebAssembly and runs inside
the browser tab or the desktop window on the machine in front of you.

The name is the seal ring that authenticates a document. It names what the
product is for — signing, sealing and keeping — in a register a university or a
government office can use.

## The promise, and how to check it

The claim is not "we don't look at your files". It is that **there is nothing to
look at**, because nothing is sent.

Anyone can test it in under a minute: open the app, turn off the network, and
keep working. Every feature except three keeps functioning — opening, editing,
OCR, redaction, export and save included. The three exceptions are each
user-initiated and each send **a hash and nothing else**: RFC 3161 trusted
timestamping, Aadhaar eSign, and an opt-in version check.

That is enforced, not promised:

- The Content-Security-Policy is `connect-src 'self'`. The browser itself
  refuses a request to any other origin.
- The desktop shell is built with **no HTTP permission at all**, so it cannot
  make a network call even by accident. Its capability set is file dialogs.
- An end-to-end test fails the build on any request to a non-self origin, and
  runs on every change.
- OCR language data, the render engine and every font are carried inside the
  build rather than fetched.

## Who it is for

Institutions in India that handle documents they are not allowed to send
anywhere: universities, IIITs and NITs, exam cells, hospitals, district offices
and government departments. Student records, mark sheets, answer scripts,
patient files, tender documents, confidential correspondence.

For these users the cloud PDF tools are not merely unattractive — they are often
not permissible. Signet removes the question by removing the upload.

## Why an Indian PDF suite

Six reasons that are about this country specifically, not about sentiment.

**1. The documents often cannot leave.** An institution that hands student or
patient records to a third-party service takes on a processor relationship under
the Digital Personal Data Protection Act, 2023, and the obligations and audits
that follow from it. Signet never receives the document, so the relationship
never forms and the question never arises. That is a smaller compliance surface,
not a legal opinion — but it is smaller for a reason anyone can verify.

**2. Indic scripts are not a long-tail locale here.** Malayalam and Hindi
language data ship with the product rather than as an afterthought. Malayalam
extraction is verified against forty real documents from Kerala LSGD and the
Kerala Assembly, and search folds Malayalam chillu spellings, so a query matches
whichever form the document happens to use. Foreign tools treat these scripts as
one more entry in a locale list; here they are the reason the OCR exists.

**3. The signatures that count here are Indian ones.** A Class 3 DSC on a USB
token and Aadhaar eSign are what an Indian registrar, tender office or court
actually accepts — not a signing service hosted abroad. *This is the next thing
being built, not something that ships today: the panel reads signatures, it
cannot yet make one.*

**4. The paperwork is Indian paperwork.** Mark sheets, provisional certificates,
result sheets, seating lists — produced in bulk from a template and a
spreadsheet, because that is the work the lab and its neighbours in the
institute actually do. Batch sequences were not a feature request; they were
Tuesday.

**5. It works where the network does not.** Campus offices, district offices,
examination halls and anywhere the link drops at four in the afternoon. Signet
is offline by construction rather than offline as a degraded mode, so nothing
behaves differently when the connection goes.

**6. Priced and owned here.** A site licence for a campus instead of per-seat
subscriptions billed in dollars, and an open core that a state university's own
IT department can read, build and verify for itself. An institution should be
able to check the privacy claim of the software holding its students' records
without taking anyone's word for it.

## What it does today

Everything listed here is built and covered by tests. `docs/ADOBE-PARITY.md` is
the audited gap list, read from the code rather than from memory.

**Read and find.** Virtualised viewer for 500-page files, fit-width and
fit-page, thumbnails, single-page and two-up, full screen, a real text layer so
selection, copy and the browser's own find all work on real text. Search with a
match count and highlights, insensitive to case and to Unicode normalisation —
so Malayalam and Hindi match whichever form the document uses.

**Organise.** Merge, insert at a position, reorder by drag or keyboard, rotate,
delete, extract, split, crop, watermark, page labels. Bookmarks that can be
added, renamed, moved and removed as a real outline tree. Links and named
destinations. Headers, footers, page numbers and Bates numbering with number
styles, padding and ranges.

**Edit.** Click a paragraph and type over it: the text changes in the document
itself, keeping its font, size, colour and position, and re-wrapping to its own
width measured in the real font. Change a block's size and face from a format
bar. Move, resize, replace, turn and downsample pictures in place.

**Mark up.** Highlight, underline, strike-through, sticky note, free text, box,
oval, freehand, line, arrow, polygon, cloud, polyline, callout, caret, stamps
and picture stamps — all written as real PDF annotations with generated
appearance streams, so another viewer shows exactly what this one shows.

**Sign a form.** The three ways Acrobat Reader's Fill & Sign offers: draw your
signature, type your name, or use a photo or scan of a real one. Made once,
kept in this browser only, and placed on any page by a click or by dragging the
size the form's line needs. This is an electronic signature — a mark on the
page, proving what a signature on a paper form proves. Cryptographic signing is
listed below as not yet built, and these are not a substitute for it. Comment replies and review states as threads. XFDF import and export, so
a review needs no server. A marks panel that filters, searches and sorts.

**Forms.** Fill and save AcroForms of every field kind, with flattening and
read-only fields respected. A builder to draw, name and remove text boxes, tick
boxes and dropdowns. Calculated fields computed by our own code — never by
JavaScript carried in the document.

**Scan and recognise.** Tesseract OCR to a searchable PDF in English, Malayalam
and Hindi, with an invisible text layer; pages that already have text are
skipped rather than re-recognised. Despeckling on by default, which turns an 8%
speckled scan from 0% accuracy into 100%. Scanning from the machine's own
scanner on the desktop.

**Protect and prove.** AES-256 password protection and removal, permissions,
true redaction that removes the content and then re-reads the file to prove no
text survived, find-and-redact by pattern for Aadhaar, PAN, phone and email, and
a hidden-information remover for metadata, XMP, embedded files, scripts and
actions. A signature panel reporting who signed, when, and whether anything was
appended afterwards.

**Convert.** To Word as a real .docx — a paragraph per paragraph, tables as real
tables with their headings kept, and landscape pages in their own section. To
plain text, to CSV, to PNG per page. From images, from a scanner, and from Word
or Excel through the machine's own LibreOffice on the desktop.

**Check.** PDF/A and print preflight, and an accessibility check covering title,
language, tagging, window title, scanned pages without text and pictures without
descriptions — fixing the title, the language and the window-title flag in place.

**Work in bulk.** A sequence of steps run over many files, each step working on
what the last produced, plus filling one form once per spreadsheet row — grade
cards, certificates and result sheets from a template and a CSV. Sequences can
be named and kept.

**Throughout.** Undo and redo across page order, marks and document bytes. A
command palette. Long jobs that report their progress page by page and can be
stopped. Everything keyboard-reachable.

## What it deliberately does not do

These are not gaps. They are the trade:

- **No cloud storage, sync or sharing links.** No hosted review, no real-time
  collaboration.
- **No document JavaScript.** Acrobat executes code embedded in a PDF. Running a
  document's own code on a machine holding student records is a bad trade for
  the convenience of a calculated field, so form calculations are done by our
  code instead.
- **No cloud AI.** Acrobat Studio's summarise and chat send the document to
  Adobe. The idea is kept and the model moves on-device; if it cannot run
  locally, it does not ship.
- **No XFA forms.** Legacy, and reported plainly rather than shown empty.

## Still to come

Stated honestly, because the product's whole claim is that it tells the truth
about itself:

- **Cryptographic signing.** Class 3 DSC over PKCS#11, PAdES with an RFC 3161
  timestamp, and Aadhaar eSign. The panel reads signatures today; it cannot yet
  make one.
- **Accessibility tagging** and PDF/UA validation. The check is done; the tag
  tree is not.
- **Windows and Linux desktop builds.** The release pipeline bundles them; no
  one has opened one yet. macOS is built and run.
- **PDF/A conversion** — the check exists, the conversion is deferred (ADR 0008).

## How it is built

| Concern | Choice |
| --- | --- |
| Rendering and text geometry | PDFium, compiled to WebAssembly |
| Structural edits | pdf-lib |
| Repair, encryption, recompression | qpdf, compiled to WebAssembly |
| OCR | Tesseract (WebAssembly in the browser, native on the desktop) |
| Office → PDF | The machine's own LibreOffice, desktop only |
| Web app | Vite + React, an installable PWA that works fully offline after first load |
| Desktop | Tauri 2 — the same interface in a native window, with native file dialogs |

Every dependency is permissively licensed and audited by a check that fails the
build on anything outside the allow-list. AGPL, GPL, SSPL and BUSL are banned
outright, as are MuPDF, PyMuPDF and Ghostscript — which is why some things here
were harder than they look, and why a few remain out of reach.

Nothing is fetched at runtime. The licences of everything compiled in are in
`THIRD_PARTY_NOTICES.txt`, generated and committed.

## Why it wins against Adobe Acrobat

1. **Zero upload, verifiable.** Switch off the network and it keeps working. The
   core is open source, so the claim can be audited rather than believed.
2. **No data-processor relationship.** We never receive user data, which removes
   a whole chapter of DPDP Act compliance for the customer.
3. **Indic text as a first-class concern.** Malayalam extraction verified on 40
   real government documents; search folds Malayalam chillu spellings; OCR ships
   Malayalam and Hindi alongside English.
4. **Indian signatures.** Class 3 DSC over a USB token and Aadhaar eSign, rather
   than a signing service abroad.
5. **Institutional pricing.** A campus or site licence instead of per-seat
   subscriptions, with offline machine-bound licensing.
6. **Built for the work this institution actually does.** Grade cards,
   certificates and result sheets in bulk, from a template and a spreadsheet.

## Editions

| Edition | Includes | Licence |
| --- | --- | --- |
| Community | View, annotate, organise, compress, password protect (web + desktop) | Open source |
| Institution | Indic OCR, forms, redaction, DSC/PAdES signing, Office→PDF, batch folder processing | Commercial, site licence |
| Enterprise | Local AI, PDF/A + PDF/UA validation, priority support, custom workflows | Commercial |

## Branding rule

Never use "Adobe" or "Acrobat" in the product name, in the interface, or in a
marketing claim. Comparison belongs in `docs/ADOBE-PARITY.md`, which is an
internal engineering document.

## Success measures (first six months)

- Renders the 1,000-file institutional corpus with no regressions.
- Live in three offices at IIIT Kottayam.
- First external institution signed.

## The lab

Signet is built by **FACTS-H Lab** at the **Indian Institute of Information
Technology, Kottayam**. The lab's other work includes the Exam Seating tool,
whose offline machine-bound licensing scheme Signet reuses.
