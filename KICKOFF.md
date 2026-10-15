# Kickoff prompts for Claude Code

Paste these one at a time. Review and commit after each.

## 1. Scaffold the monorepo
```
Read CLAUDE.md and all files in docs/. Then scaffold Phase 0:
- apps/web: Vite + React + TypeScript, extending tsconfig.base.json, with a strict
  CSP meta tag exactly as in docs/PRIVACY.md and a vite-plugin-pwa service worker
  that caches only app assets (never documents).
- packages/engine, packages/core, packages/workers, packages/ui with package.json,
  tsconfig and a Vitest setup. Put the PdfEngine and DocHandle interfaces from
  docs/ARCHITECTURE.md in packages/engine/src/types.ts.
- ESLint + Prettier at the root.
- A GitHub Actions workflow running lint, typecheck, test, check:licenses and e2e.
Plan first, list files, then implement. Make `pnpm dev` and `pnpm e2e` pass.
```

## 2. Engine spike (ADR 0002)
```
Implement two adapters behind the PdfEngine interface: packages/engine/src/pdfjs
(pdf.js) and packages/engine/src/pdfium (a permissively licensed PDFium WASM build;
verify its licence with pnpm check:licenses first). Write a benchmark script that,
for every PDF in corpus/, measures open time, first-page render time, peak memory
and failures for each engine. Then draft docs/adr/0002-rendering-engine.md with the
results and a recommendation. Do not read corpus file contents into the chat;
only report aggregate numbers.
```

## 3. First vertical slice
```
Build the Phase 1 viewer slice: open a PDF via the File System Access API (with an
<input type=file> fallback), render pages in a Web Worker with virtualised
scrolling and thumbnails, and add merge + reorder using packages/core (pdf-lib).
Save via the native save dialog. Extend e2e/offline.spec.ts to cover open → merge →
save with a fixture PDF generated in the test. Tick the done items in docs/ROADMAP.md.
```
