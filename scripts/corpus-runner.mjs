#!/usr/bin/env node
// Corpus regression runner. For every PDF in corpus/: open it (with the
// repair-on-open fallback), render page 1, extract its text, round-trip it
// through packages/core, and re-open what was written.
//
// This is the Phase 1 gate ("renders the corpus with no regressions"), so it
// exits non-zero when a file that previously worked now fails.
//
// corpus-report/corpus.json is the baseline: the last run with no regressions.
// It is deliberately NOT updated when regressions are found, or a second run
// would treat the breakage as the new normal and the gate would pass. Every run
// also writes corpus-report/corpus-latest.json. Use --accept to move the
// baseline on purpose, once a change in behaviour is understood and wanted.
//
// Corpus bytes are read by the browser from localhost and go nowhere else. No
// filename or document content is printed: only counts, timings and failures.
//
//   node scripts/corpus-runner.mjs [--dir corpus] [--scale 1.5] [--limit N]
//                                  [--ocr mal,eng] [--json]
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const benchRoot = join(repoRoot, "packages/workers/bench");
const reportDir = join(repoRoot, "corpus-report");
const baselineFile = join(reportDir, "corpus.json");
const latestFile = join(reportDir, "corpus-latest.json");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const corpusDir = resolve(repoRoot, flag("dir", "corpus"));
const scale = Number(flag("scale", "1.5"));
const limit = Number(flag("limit", "0"));

function findPdfs(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.toLowerCase().endsWith(".pdf")) out.push(p);
    }
  };
  try {
    walk(dir);
  } catch {
    return [];
  }
  return out.sort();
}

let files = findPdfs(corpusDir);
if (limit > 0) files = files.slice(0, limit);

if (files.length === 0) {
  console.log(`No PDFs under ${corpusDir.replace(repoRoot + "/", "")}/.`);
  console.log("");
  console.log("Add documents there and run this again. See corpus/README.md for the");
  console.log("mix to aim for: scanned (incl. Malayalam and Hindi), forms, signed,");
  console.log("malformed, large, and office exports. Nothing in corpus/ is ever");
  console.log("committed, and this runner prints only counts and timings.");
  console.log("");
  console.log("Until it has files, these stay unanswerable:");
  console.log("  - the Phase 1 gate: renders the corpus with no regressions");
  console.log("  - ADR 0002: PDFium vs pdf.js on real documents");
  console.log("  - ADR 0004: OCR accuracy on real Malayalam and Hindi scans");
  process.exit(0);
}

/** Identify a file by a hash of its path, so no filename reaches the report. */
const idOf = (path) => createHash("sha256").update(path).digest("hex").slice(0, 12);

const pdfiumWasm = require.resolve("@embedpdf/pdfium/pdfium.wasm", {
  paths: [join(repoRoot, "packages/engine")],
});
const qpdfWasm = require.resolve("@neslinesli93/qpdf-wasm/dist/qpdf.wasm", {
  paths: [join(repoRoot, "packages/core")],
});

// --ocr runs the shipped OCR path over any page that has no text layer, which
// is the only way to see what Tesseract does with the real scans in the corpus.
const ocrLangs = flag("ocr", undefined);
let ocrConfig;
if (ocrLangs) {
  const tesseractDir = resolve(
    require.resolve("tesseract.js/package.json", { paths: [join(repoRoot, "packages/ocr")] }),
    "..",
  );
  const coreDir = resolve(
    require.resolve("tesseract.js-core/package.json", { paths: [tesseractDir] }),
    "..",
  );
  const langDir = join(repoRoot, "vendor/tessdata/fast");
  if (!existsSync(langDir)) {
    console.error("No language data. Run: node scripts/fetch-tessdata.mjs");
    process.exit(2);
  }
  ocrConfig = {
    languages: ocrLangs.split(","),
    assets: {
      workerPath: `http://localhost:5197/@fs${join(tesseractDir, "dist/worker.min.js")}`,
      corePath: `http://localhost:5197/@fs${coreDir}/`,
      langPath: `http://localhost:5197/@fs${langDir}/`,
    },
  };
}
const fsUrl = (p) => `/@fs${p}`;

console.log(`Running ${files.length} PDFs from ${corpusDir.replace(repoRoot + "/", "")}/.`);

const server = await createServer({
  root: benchRoot,
  configFile: false,
  logLevel: "warn",
  server: { port: 5197, strictPort: true, fs: { allow: [repoRoot, corpusDir] } },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.error("  [page]", m.text().slice(0, 160));
});

let results;
try {
  await page.goto("http://localhost:5197", { waitUntil: "load" });
  await page.waitForFunction("typeof window.runCorpus === 'function'");
  results = await page.evaluate(
    // eslint-disable-next-line no-undef -- this arrow runs in the page, not in node
    ([urls, config]) => window.runCorpus(urls, config),
    [
      files.map(fsUrl),
      {
        pdfiumWasmUrl: fsUrl(pdfiumWasm),
        qpdfWasmUrl: fsUrl(qpdfWasm),
        scale,
        ...(ocrConfig ? { ocr: ocrConfig } : {}),
      },
    ],
  );
} finally {
  await browser.close();
  await server.close();
}

// Keyed by a hash of the path so the report carries no filenames.
const byId = new Map(results.map((r, i) => [idOf(files[i]), { ...r, file: idOf(files[i]) }]));
const ok = (r) => !r.error;
const median = (xs) => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const pick = (key) =>
  [...byId.values()].map((r) => r[key]).filter((v) => typeof v === "number" && Number.isFinite(v));
const fmt = (x) => (x === undefined ? "—" : `${x < 10 ? x.toFixed(1) : x.toFixed(0)}ms`);

const previous = existsSync(baselineFile)
  ? JSON.parse(readFileSync(baselineFile, "utf8"))
  : { files: {} };

const regressions = [];
const fixed = [];
for (const [id, result] of byId) {
  const before = previous.files?.[id];
  if (!before) continue;
  if (ok(before) && !ok(result)) regressions.push({ id, was: "ok", now: result.error });
  else if (!ok(before) && ok(result)) fixed.push(id);
  // A page count that changes on the same bytes is also a regression.
  else if (ok(result) && before.pageCount !== undefined && before.pageCount !== result.pageCount) {
    regressions.push({ id, was: `${before.pageCount} pages`, now: `${result.pageCount} pages` });
  }
}

const failed = [...byId.values()].filter((r) => r.error);
const summary = {
  generatedAt: new Date().toISOString(),
  corpus: { dir: corpusDir.replace(repoRoot + "/", ""), files: files.length },
  scale,
  opened: [...byId.values()].filter(ok).length,
  failed: failed.length,
  repaired: [...byId.values()].filter((r) => r.repaired).length,
  needPassword: [...byId.values()].filter((r) => r.needsPassword).length,
  withForms: [...byId.values()].filter((r) => (r.formFields ?? 0) > 0).length,
  withOutline: [...byId.values()].filter((r) => (r.outlineItems ?? 0) > 0).length,
  // An encrypted file has no text because it never opened, which is not the
  // same as a scan. Counting it as an OCR candidate was wrong.
  withoutText: [...byId.values()].filter(
    (r) => ok(r) && !r.needsPassword && (r.textRuns ?? 0) === 0,
  ).length,
  pages: pick("pageCount").reduce((a, b) => a + b, 0),
  // Weighted script mix of extracted text, which is how Indic extraction is
  // verified against real documents rather than against fixtures we wrote.
  scripts: (() => {
    const totals = {};
    let weight = 0;
    for (const r of byId.values()) {
      if (!r.textScripts || !r.textRuns) continue;
      weight += r.textRuns;
      for (const [script, pct] of Object.entries(r.textScripts)) {
        totals[script] = (totals[script] ?? 0) + pct * r.textRuns;
      }
    }
    if (weight === 0) return undefined;
    for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] / weight);
    return totals;
  })(),
  openMedian: median(pick("openMs")),
  renderMedian: median(pick("renderMs")),
  roundTripMedian: median(pick("roundTripMs")),
};

mkdirSync(reportDir, { recursive: true });
const report = JSON.stringify({ summary, files: Object.fromEntries(byId) }, null, 2);
writeFileSync(latestFile, report);

if (argv.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\nopened ${summary.opened}/${files.length}, ${summary.pages} pages total`);
  console.log(
    `open ${fmt(summary.openMedian)} | render page 1 ${fmt(summary.renderMedian)} | ` +
      `round-trip ${fmt(summary.roundTripMedian)} (medians)`,
  );
  console.log(
    `repaired on open: ${summary.repaired} | encrypted: ${summary.needPassword} | ` +
      `with forms: ${summary.withForms} | with bookmarks: ${summary.withOutline}`,
  );
  console.log(`no text layer (real scans, candidates for OCR): ${summary.withoutText}`);
  if (summary.scripts) {
    const mix = Object.entries(summary.scripts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}%`)
      .join(", ");
    console.log(`extracted text by script, across every opened page 1: ${mix}`);
  }
  const ocrd = [...byId.values()].filter((r) => r.ocr);
  if (ocrd.length > 0) {
    console.log(`\nOCR over ${ocrd.length} page(s) with no text layer:`);
    for (const r of ocrd) {
      const mix = Object.entries(r.ocr.scripts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}%`)
        .join(", ");
      console.log(
        `  ${r.file}  ${r.ocr.ms.toFixed(0)}ms  ${r.ocr.chars} chars in ${r.ocr.runs} runs  [${mix}]`,
      );
    }
    console.log("  (no ground truth for a real scan, so this is output shape, not accuracy)");
  }

  if (failed.length > 0) {
    console.log(`\nfailures (${failed.length}), by message:`);
    const byMessage = new Map();
    for (const r of failed) byMessage.set(r.error, (byMessage.get(r.error) ?? 0) + 1);
    for (const [message, count] of [...byMessage].sort((a, b) => b[1] - a[1])) {
      console.log(`  x${count}  ${message}`);
    }
  }
}

if (fixed.length > 0) console.log(`\n${fixed.length} file(s) now work that did not before.`);

const accept = argv.includes("--accept");
if (regressions.length > 0 && !accept) {
  console.error(`\nREGRESSIONS (${regressions.length}):`);
  for (const r of regressions) console.error(`  ${r.id}: was ${r.was}, now ${r.now}`);
  console.error("\nThe baseline is unchanged, so this keeps failing until it is fixed.");
  console.error("corpus-report/corpus-latest.json has this run; --accept moves the baseline.");
  process.exit(1);
}

// Only a clean run (or an explicit --accept) becomes the new baseline.
writeFileSync(baselineFile, report);
console.log(
  regressions.length > 0
    ? `\nAccepted ${regressions.length} change(s) as the new baseline.`
    : "\nNo regressions against the baseline. Baseline updated: corpus-report/corpus.json",
);
