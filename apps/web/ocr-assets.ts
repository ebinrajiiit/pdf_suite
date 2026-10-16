import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { Connect, Plugin } from "vite";

/**
 * Serves Tesseract's worker, wasm core and language data from our own origin.
 *
 * tesseract.js would fetch all three from jsDelivr, which privacy invariants 2
 * and 3 forbid (CLAUDE.md §1). They are not imported as modules because
 * tesseract.js resolves the core by *directory* and appends filenames at
 * runtime, so the files have to exist at predictable paths rather than hashed
 * bundler names.
 *
 * They are deliberately NOT precached by the service worker: the core and the
 * language data are ~16 MB together, which would triple first load for the
 * majority of users who never run OCR. They are fetched the first time OCR is
 * used and then kept in IndexedDB by tesseract.js, which is the "language packs"
 * case docs/PRIVACY.md permits.
 */

const require = createRequire(import.meta.url);

/** Only the LSTM builds: we ship LSTM language data, so the legacy engine is dead weight. */
const CORE_FILES = [
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm.js",
];

export const OCR_BASE = "/ocr";

function tesseractDir(): string {
  return dirname(require.resolve("tesseract.js/package.json"));
}

/**
 * Resolved through tesseract.js rather than directly, because tesseract.js loads
 * the core version *it* depends on. Installing tesseract.js-core alongside it
 * silently gave us 6.1.2 while tesseract.js 7 asked for 7.0.0, whose file names
 * differ — so the build copied two of three core variants and OCR failed on any
 * browser with relaxed SIMD.
 */
function coreDir(): string {
  const fromTesseract = createRequire(join(tesseractDir(), "package.json"));
  return dirname(fromTesseract.resolve("tesseract.js-core/package.json"));
}

function workerFile(): string {
  return join(tesseractDir(), "dist/worker.min.js");
}

/** Language data lives outside the repo; see scripts/fetch-tessdata.mjs. */
function langDir(root: string): string {
  return resolve(root, "../../vendor/tessdata/fast");
}

function send(res: Parameters<Connect.NextHandleFunction>[1], file: string): boolean {
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.setHeader(
    "Content-Type",
    file.endsWith(".js") ? "text/javascript" : "application/octet-stream",
  );
  res.setHeader("Cache-Control", "no-cache");
  res.end(readFileSync(file));
  return true;
}

export function ocrAssets(): Plugin {
  let root = process.cwd();

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (!url.startsWith(`${OCR_BASE}/`)) return next();

    // One optional directory segment and a filename, never a traversal.
    const name = url.slice(`${OCR_BASE}/`.length);
    if (name.includes("..") || name.split("/").length > 2) return next();

    if (name === "worker.min.js" && send(res, workerFile())) return;
    if (name.startsWith("core/") && send(res, join(coreDir(), name.slice(5)))) return;
    if (name.startsWith("lang/") && send(res, join(langDir(root), name.slice(5)))) return;

    res.statusCode = 404;
    res.end(
      name.startsWith("lang/")
        ? "No language data. Run: node scripts/fetch-tessdata.mjs"
        : "Not found",
    );
  };

  return {
    name: "pdf-suite:ocr-assets",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    // A build has to put the real files in dist, since the paths are resolved at
    // runtime rather than by the bundler.
    closeBundle() {
      const out = join(root, "dist", OCR_BASE.slice(1));
      mkdirSync(join(out, "core"), { recursive: true });
      mkdirSync(join(out, "lang"), { recursive: true });
      copyFileSync(workerFile(), join(out, "worker.min.js"));
      for (const file of CORE_FILES) {
        const from = join(coreDir(), file);
        if (existsSync(from)) copyFileSync(from, join(out, "core", file));
      }
      const langs = langDir(root);
      if (!existsSync(langs)) {
        this.warn(
          "No vendor/tessdata: OCR will not work in this build. Run scripts/fetch-tessdata.mjs",
        );
        return;
      }
      for (const file of readdirSync(langs)) {
        if (file.endsWith(".traineddata")) copyFileSync(join(langs, file), join(out, "lang", file));
      }
    },
  };
}
