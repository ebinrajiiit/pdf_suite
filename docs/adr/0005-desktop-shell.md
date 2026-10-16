# ADR 0005 — Tauri 2 for the desktop shell

- Status: **Proposed** — the shell builds and runs; what needs sign-off is the licence question in "A new licence category" below.
- Date: 2026-10-16

## Context

`docs/ARCHITECTURE.md` names Tauri 2 for the desktop app, and Phase 2's gate is
"live in 3 offices at IIIT Kottayam". The desktop build is not about a different
UI — it is the same web app — it is about the three things a browser cannot do:
native Tesseract for batch folders, LibreOffice for Office conversion, and
PKCS#11 for USB DSC tokens in Phase 3.

## Decision

**Tauri 2**, wrapping the built web UI from `apps/web/dist`.

The alternative worth naming is Electron: it ships a whole Chromium, which for a
product whose pitch is "nothing leaves your device" is both a 100 MB+ download
and a much larger attack surface. Tauri uses the system webview — 23 MB for our
binary on macOS — and its capability system makes "this app cannot reach the
network" a thing the build enforces rather than a thing we promise.

That last point is the real reason. See below.

## What was built and verified

- `apps/desktop/src-tauri` with `tauri-plugin-dialog` and `tauri-plugin-fs`, and
  nothing else.
- `cargo check` passes; `tauri build --no-bundle` produces a 23 MB binary in
  about a minute on an M-series Mac.
- The binary runs, the window opens, and the web UI loads inside it — including
  PDFium's 4.4 MB wasm, which compiles under the Tauri CSP and leaves the app
  reporting "Ready". That was the failure this ADR most expected, and it did not
  happen.
- Icons are generated from `apps/web/public/icon.svg`.

Two things fixed while getting there:

1. `assetProtocol.enable: true` in the config without the matching
   `protocol-asset` Cargo feature **fails the build**. We do not need the asset
   protocol at all — documents arrive as bytes and stay in memory, never loaded
   through `asset://` — so it was removed rather than enabled. Two origins came
   out of the CSP with it.
2. The desktop package's scripts are `tauri:dev` and `tauri:build`, not `dev`
   and `build`: the root scripts are recursive, so a `build` here would make
   `pnpm build` compile Rust on every machine and in CI.

## Privacy, enforced rather than promised

`capabilities/default.json` grants file dialogs and the files the user picks
through them. There is **no HTTP permission and no updater plugin**, and
`Cargo.toml` pulls in no HTTP client. `docs/PRIVACY.md` allows exactly four
network calls and none of them are implemented, so the shell cannot make one
even by accident. Adding one means an ADR and a new row in that table, not
enabling a plugin.

This is stronger than the web app's guarantee, which rests on a CSP the browser
enforces. Here the capability simply does not exist in the binary.

## A new licence category

A Tauri build links **several hundred Rust crates**, every one of which ships
inside the binary a customer installs — and `pnpm check:licenses` reads npm
metadata and `scripts/third-party.json`, neither of which knows anything about
Cargo. That gap is now closed by `pnpm check:licenses:rust`, which reads
`cargo metadata` and applies the same allow-list.

Its first run found **18 crates under `Unicode-3.0`**: the ICU family
(`icu_collections`, `icu_normalizer`, `icu_properties` and siblings) that Tauri
pulls in transitively, declared as `(MIT OR Apache-2.0) AND Unicode-3.0`. The
`AND` means the Unicode licence applies regardless of which of the other two we
take.

The Unicode License v3 is permissive and attribution-only: no copyleft, no
field-of-use restriction. It is the standard licence for Unicode's own data
tables and ships in effectively every modern browser and operating system.

**Recommendation: allow `Unicode-3.0`.** It is in
`scripts/allowed-licences.json` so the repo is self-consistent and CI is
meaningful, marked as pending this ADR. If the lab rejects it, the fallback is
unpleasant — the ICU crates come in through Tauri's own dependency tree, so
removing them means patching or forking that tree, not swapping one package.

Two smaller things the same run established, both fine: one crate is
`Apache-2.0 WITH LLVM-exception` (the exception only widens the grant), and
several use Cargo's old `MIT/Apache-2.0` slash syntax, which means `OR`. The
checker handles both.

`Cargo.lock` is committed, as it should be for an application: it is what makes
a desktop build reproducible, and CI's `cargo check --locked` requires it.

## Consequences

- A second CI job, on macOS, Ubuntu and Windows, running the crate licence check
  and `cargo check`. It is separate from `check` so a broken web app still fails
  in under a minute instead of behind a Rust compile.
- `THIRD_PARTY_NOTICES.txt` does **not** yet cover the Rust crates. It must
  before a desktop release; the generator needs a Cargo pass alongside its npm
  and wasm ones.
- The web app's File System Access calls do not exist in WKWebView, so inside the
  shell it silently falls back to a hidden file input and downloads. Native
  dialogs via the Tauri plugins are the next desktop task, and they need the
  frontend to branch on the Tauri environment.
