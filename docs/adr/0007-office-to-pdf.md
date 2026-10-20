# ADR 0007 — Office documents to PDF

- Status: **Accepted** — detection and conversion are built for the desktop shell; bundling is deliberately not done.
- Date: 2026-10-20

## Context

Half the documents an institution turns into PDFs start as `.docx`, `.xlsx` or
`.odt`. `docs/ROADMAP.md` has had "Office → PDF, desktop only, via LibreOffice"
in Phase 2 since the start, and `docs/ARCHITECTURE.md` names LibreOffice
headless as the converter.

The real question was never which converter — nothing else does Office layout
properly — but whether to **bundle** it.

## Decision

**Use LibreOffice if the machine has it. Do not bundle it. Do not install it.**

The desktop shell looks for `soffice` in the places it normally lives, runs it
headless to convert a file in a temporary directory, and reads the PDF back. If
it is not installed, the app says so and names the download page rather than
failing silently or offering to fetch anything itself.

### Why not bundle

- **Size.** LibreOffice is 400 MB+. Our whole desktop binary is 23 MB (ADR
  0005). Bundling it makes the download seventeen times larger for a feature
  many users never touch.
- **Licence.** LibreOffice is MPL-2.0, which `docs/LICENSE-POLICY.md` allows,
  so this is not a licence objection — but shipping it makes us its
  distributor, with the notices and the update burden that implies.
- **Updates.** A bundled copy is a copy we are responsible for patching. A
  system copy is the distribution's problem, which is where it belongs.

### Why not convert in the browser

There is no in-browser Office converter that is honest about `.docx` layout.
The ones that exist reflow the document, which for a transcript or a letter
means a PDF that does not match the original — worse than no feature.

### What runs

`soffice --headless --norestore --convert-to pdf --outdir <temp> <file>`, in a
temporary directory of our own making. No network, no profile sharing with the
user's own LibreOffice session, and the temporary files are removed afterwards.

The path is searched in this order, and nothing else is executed:
`/Applications/LibreOffice.app/Contents/MacOS/soffice`, `soffice` on `PATH`,
`/usr/bin/soffice`, `/usr/lib/libreoffice/program/soffice`, and on Windows the
two `Program Files` locations. A user-supplied path is not accepted, because
"tell me where your converter is" is a fine way to get an app to run anything.

## Consequences

- Desktop converts Office files; the browser build says it cannot, and why.
  That asymmetry is the reason the desktop build exists (ADR 0005).
- A machine without LibreOffice gets a clear message with the download page,
  not a mystery.
- Conversion fidelity is LibreOffice's, which is the best available and is not
  perfect. The UI does not claim otherwise.
- Nothing is bundled, so `THIRD_PARTY_NOTICES.txt` is unchanged.
