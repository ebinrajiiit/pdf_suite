# ADR 0006 — Certificate-based signatures

- Status: **Proposed** — validation is built and shipped; signing is specified here and not yet built.
- Date: 2026-10-20

## Context

An institution both sends and receives signed PDFs. The receiving half is the
one that bites first: a signed transcript or a tender document arrives, and the
registrar's question is whether the signature is sound and what it covers. Our
viewer currently says nothing at all about signatures, which is worse than
saying "this one is signed but I cannot check it" — the reader assumes there is
nothing to check.

The sending half, signing, is a bigger piece of work and splits in two:

1. **A software certificate** — a `.p12`/`.pfx` file the user holds. Everything
   needed happens in our own process.
2. **A hardware token** — the USB DSC tokens Indian institutions actually use
   for statutory filings. The private key never leaves the token; signing means
   PKCS#11 against a vendor driver, which a browser cannot reach at all.

## Decision

**Three steps, in this order, and only the first is built now.**

### 1. Validation (built)

Read the signature fields and report, for each: who signed, when they say they
signed, what the signature covers, and whether anything was appended after it.
This is parsing, not cryptography — no library, no dependency — and it answers
the question a reader actually has. What it deliberately does **not** claim is
that the cryptography verifies: `packages/core/src/signatures.ts` reports
coverage and the signer's stated identity, and the UI says in those words that
the certificate chain has not been checked.

Implementing coverage is the part worth being careful about. A `/ByteRange` of
`[0 a b c]` means the signature covers everything except the gap where the
signature itself sits; if `a + b` and the rest do not reach the end of the file,
content was appended after signing and a reader must be told. That check is
cheap and catches the single most common way a signed PDF is abused.

### 2. Signing with a software certificate (specified, not built)

- **`@signpdf/signpdf`** (MIT) for the placeholder and byte-range handling, with
  **`node-forge`** (BSD-3-Clause) for the PKCS#7/CMS. Both are on the licence
  allow-list; neither needs a server.
- The `.p12` and its passphrase are read in the worker, used, and dropped. They
  are never written anywhere, and the privacy invariants already forbid the only
  thing that would make them dangerous — sending them anywhere.
- A timestamp from an RFC 3161 server is the one network call involved, and
  `docs/PRIVACY.md` already allows it: it sends a hash and nothing else. It
  stays opt-in and off by default.

### 3. PKCS#11 for USB tokens (specified, Phase 3, desktop only)

- The **`cryptoki`** crate (Apache-2.0) in the Tauri shell, talking to the
  vendor's PKCS#11 driver, which the user installs themselves.
- A Rust command signs the hash; the PDF assembly stays in TypeScript, so the
  desktop and browser paths differ in exactly one step.
- This cannot be tested in CI — it needs a physical token — so it lands with a
  manual test script and a named person who ran it.

## Consequences

- A reader can tell a signed document from an unsigned one today, and can see
  when something was appended after signing.
- We do not claim cryptographic validity until the chain is actually checked.
  Half-claiming it would be the worst of both: a user who believes the file is
  verified when nothing verified it.
- Signing will add two dependencies, both permissively licensed and both
  bundled. `pnpm check:licenses` will have to pass with them before they land.
- The hardware path means the desktop build becomes the one that matters for
  statutory work, which is already its reason to exist (ADR 0005).
