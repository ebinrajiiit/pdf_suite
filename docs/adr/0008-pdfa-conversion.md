# ADR 0008 — PDF/A: audit now, convert later

- Status: **Accepted** — the audit ships; conversion waits on an output profile we are allowed to bundle.
- Date: 2026-10-20

## Context

PDF/A is the format an archive, a court or a university registry asks for, and
it is one of the few acronyms an institutional user will name without
prompting. Acrobat has both halves of it: a preflight that says whether a file
conforms, and a conversion that makes it conform.

We have the first half. `checkStandard` reports what stops a document being
PDF/A — fonts that are not embedded, transparency, encryption, no XMP, no
output intent — page by page and plainly. That part needs nothing but the
parser we already have.

The second half is not the same kind of work:

1. **Fonts.** A document whose fonts are not embedded cannot be made to conform
   without embedding them, which means having a face to embed. Substituting a
   different face changes what the page looks like, which is the one thing an
   archival format exists to prevent. Doing it properly means shipping a font
   family with metrics close enough to the common Windows faces, in a licence
   on our allow list, for Latin **and** for Malayalam and Devanagari — since
   `CLAUDE.md` says Indic text is first-class, a converter that only works for
   English is not a converter.
2. **An output intent.** PDF/A requires an `/OutputIntent` with an embedded ICC
   profile. The obvious one is sRGB. The profile is a binary asset with its own
   licence, and `docs/LICENSE-POLICY.md` applies to assets as much as to code:
   an "sRGB.icc" of unknown provenance is exactly the unlicensed dependency the
   policy exists to keep out.

Both are bundle-size and licence decisions, not programming decisions. Together
they are also several megabytes added to a download that currently works
offline on a phone tether.

## Decision

**Ship the audit. Do not ship a conversion that cannot be honest about what it
changed.**

Concretely, for now:

- `Check PDF/A` reports conformance problems and names each one.
- Where a problem can be fixed without guessing — a missing title, a missing
  language, missing XMP — the fix is offered by the tools that already do it
  (document properties, the accessibility fixer).
- Nothing is labelled PDF/A-1b or PDF/A-2b by this application until it really
  is, including the XMP identification: writing that claim into a file that
  does not conform is worse than not converting, because the next tool believes
  it.

## When this changes

Conversion gets built when both of these are settled, and it is one task:

- An sRGB ICC profile under a licence on the allow list, with its provenance
  recorded here. The ICC's own sRGB profiles and the ones shipped with
  permissively licensed colour libraries are the candidates to check.
- A font plan: which faces are embedded for substitution, under which licence,
  for which scripts, and what the UI says when a document needs a face we do
  not have. "Converted, and three fonts were substituted" is an acceptable
  message; silently changing the page is not.

Until then the honest answer to "can it make PDF/A?" is no, and
`docs/ADOBE-PARITY.md` says so in those words.

## Consequences

- An institution that must deposit PDF/A still needs another tool for the final
  step. It can at least find out here, offline, whether the file is already
  conformant — which for a document produced from a modern word processor with
  embedded fonts it often is.
- No new runtime network call: both the profile and any fonts would be bundled,
  never fetched. That constraint is why this is a bundle decision at all.
