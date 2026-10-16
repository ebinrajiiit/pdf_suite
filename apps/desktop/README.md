# Desktop shell (Tauri 2)

The same web UI in a native window, so the suite can do what a browser cannot:
native Tesseract for batch OCR, LibreOffice for Office conversion, and PKCS#11
for USB signing tokens. None of those are wired up yet — this is the shell.

## Status: scaffolded, not yet built

**This has never been compiled.** Rust is not installed on the machine it was
written on, so the Rust side, the capability set and the bundle targets are
unverified. `tauri info` does parse the config, so the JSON is at least valid.
Treat the first `pnpm desktop` as part of the work, not as a smoke test that
should pass.

The scripts are called `tauri:dev` and `tauri:build`, not `dev` and `build`, on
purpose: the root `pnpm build` is recursive, and a `build` script here would make
it try to compile Rust on every machine and in CI.

```bash
# Prerequisites (macOS)
xcode-select --install
curl https://sh.rustup.rs -sSf | sh

pnpm install
pnpm desktop:info    # what Tauri thinks of this machine
pnpm desktop         # runs the Vite dev server inside the window
pnpm desktop:build   # bundles for this platform
```

Windows needs the MSVC build tools and WebView2; Linux needs `libwebkit2gtk-4.1`
and `libayatana-appindicator3`. Both are documented upstream and neither has been
tried here.

## Privacy, enforced by the shell

`src-tauri/capabilities/default.json` grants file dialogs and the files the user
picks through them. There is **no HTTP permission and no updater**, so the shell
cannot make a network call even by mistake — `docs/PRIVACY.md` allows exactly
four, and none are implemented. Adding one means an ADR and a new line in that
table, not just enabling a plugin.

The CSP in `tauri.conf.json` mirrors the web one, with the `ipc:` and `asset:`
origins Tauri needs to talk to its own backend. If those two additions turn out
to be avoidable, remove them: the web CSP is the stricter reference.

## The file dialogs will need work

The web app uses the File System Access API with an `<input type=file>` and
download fallback. WKWebView (macOS) does not implement that API, so inside the
shell the app will silently take the fallback path: files open through a hidden
input and save as downloads. Functional, but not the native dialogs a desktop
app should have.

Fixing it means `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs` called
from `apps/web/src/file-io.ts` behind a runtime check for the Tauri environment,
so the same build keeps working in a browser. That is deliberately not written
yet: it cannot be tested without the toolchain, and untested integration code is
worse than none.

## What to do first, when the toolchain is there

1. `pnpm --filter @pdf-suite/desktop info` and fix whatever it reports.
2. Add an icon: `src-tauri/icons/icon.png` is referenced and does not exist yet.
   `tauri icon path/to/source.png` generates the full set.
3. Check that the window loads the built UI (`frontendDist` points at
   `apps/web/dist`) and that the engine wasm loads under the Tauri CSP — that is
   the most likely first failure, since the web app fetches its wasm from its own
   origin and Tauri serves the app from a custom protocol.
4. Native file dialogs, as above.
5. Then the work that justifies the shell: native Tesseract for batch folders,
   LibreOffice for Office conversion, PKCS#11 for USB signing tokens — in that
   order of institutional value.
