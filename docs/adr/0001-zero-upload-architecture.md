# ADR 0001 — Zero-upload, on-device architecture

- Status: Accepted
- Date: 2026-10-15

## Context
We are building an institutional PDF suite. Target customers (universities, hospitals, exam cells, government offices) handle sensitive documents. Cloud-based PDF tools require uploading documents to third-party servers, which creates compliance risk and erodes trust.

## Decision
All document processing runs on the user's device: in the browser via WebAssembly and Web Workers, and in a Tauri desktop app for native-only work (Office conversion, USB DSC tokens, large OCR batches). There is no backend that receives documents. The only permitted network calls are listed in `docs/PRIVACY.md`.

## Consequences
- Positive: verifiable privacy claim; no server costs; works offline; simpler data-protection position.
- Negative: no cloud sharing or collaboration; performance depends on the user's hardware; Office→PDF and DSC signing are desktop-only; local AI is weaker than cloud models.
- Enforced by CSP, an offline e2e test, and Tauri capability allow-lists.
