#!/usr/bin/env node
// OCR spike for ADR 0004: can Tesseract read Malayalam and Hindi in the browser,
// how fast, and how big are the assets?
//
// Everything is served from one local origin — the tesseract.js worker, the wasm
// core and the language data — because that is the only arrangement
// docs/PRIVACY.md allows. If this runs with the network cut, the production
// wiring is sound.
//
//   node scripts/fetch-tessdata.mjs      # once, into git-ignored vendor/
//   node scripts/ocr-spike.mjs [--variant fast]
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const benchRoot = join(repoRoot, "packages/ocr/bench");
const argv = process.argv.slice(2);
const variant = argv.includes("--variant") ? argv[argv.indexOf("--variant") + 1] : "fast";
const langDir = join(repoRoot, "vendor/tessdata", variant);

if (!existsSync(langDir)) {
  console.error(`No language data in vendor/tessdata/${variant}.`);
  console.error("Run: node scripts/fetch-tessdata.mjs");
  process.exit(2);
}

// tesseract.js's worker script and wasm core, from the installed package rather
// than its jsDelivr defaults.
const tesseractDir = resolve(
  require.resolve("tesseract.js/package.json", { paths: [join(repoRoot, "packages/ocr")] }),
  "..",
);
const coreDir = resolve(
  require.resolve("tesseract.js-core/package.json", { paths: [tesseractDir] }),
  "..",
);
const fsUrl = (p) => `/@fs${p}`;

const server = await createServer({
  root: benchRoot,
  configFile: false,
  logLevel: "warn",
  server: { port: 5198, strictPort: true, fs: { allow: [repoRoot] } },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
const foreign = [];
page.on("request", (req) => {
  const url = req.url();
  if (url.startsWith("data:") || url.startsWith("blob:")) return;
  if (new URL(url).origin !== `http://localhost:5198`) foreign.push(url);
});
page.on("console", (m) => {
  if (m.type() === "error") console.error("  [page]", m.text().slice(0, 160));
});

const SAMPLES = [
  {
    lang: "eng",
    label: "English",
    text: "Result sheet for semester one 2026",
    font: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  {
    lang: "mal",
    label: "Malayalam",
    text: "കേരള സർവകലാശാല പരീക്ഷാ ഫലം",
    font: '"Malayalam MN", "Nirmala UI", "Noto Sans Malayalam", sans-serif',
  },
  {
    lang: "hin",
    label: "Hindi",
    text: "परीक्षा परिणाम विद्यार्थी का नाम",
    font: '"Devanagari MT", "Nirmala UI", "Noto Sans Devanagari", sans-serif',
  },
];

let results;
try {
  await page.goto("http://localhost:5198", { waitUntil: "load" });
  await page.waitForFunction("typeof window.runOcrSpike === 'function'");
  results = await page.evaluate(
    // eslint-disable-next-line no-undef -- this arrow runs in the page, not in node
    ([assets, samples]) => window.runOcrSpike(assets, samples),
    [
      {
        workerPath: fsUrl(join(tesseractDir, "dist/worker.min.js")),
        corePath: fsUrl(coreDir) + "/",
        langPath: fsUrl(langDir) + "/",
      },
      SAMPLES,
    ],
  );
} finally {
  await browser.close();
  await server.close();
}

const reportDir = join(repoRoot, "corpus-report");
mkdirSync(reportDir, { recursive: true });
writeFileSync(
  join(reportDir, "ocr-spike.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), variant, results }, null, 2),
);

console.log(`\nTesseract language data: ${variant}\n`);
console.log("language    font?  init     ocr      conf  accuracy  words  pdf");
for (const r of results) {
  console.log(
    `${r.label.padEnd(11)} ${(r.fontAvailable ? "yes" : "NO ").padEnd(6)} ` +
      `${`${r.initMs.toFixed(0)}ms`.padStart(7)} ${`${r.recogniseMs.toFixed(0)}ms`.padStart(7)}  ` +
      `${r.confidence.toFixed(0).padStart(4)}  ${`${(r.accuracy * 100).toFixed(0)}%`.padStart(8)}  ` +
      `${String(r.words).padStart(5)}  ${r.pdfBytes ? `${(r.pdfBytes / 1024).toFixed(0)}kB` : "—"}`,
  );
  if (r.error) console.log(`            error: ${r.error}`);
}
for (const r of results) {
  if (!r.fontAvailable) {
    console.log(`\n${r.label}: no font for this script, so its accuracy means nothing.`);
  } else if (r.accuracy < 0.95) {
    console.log(`\n${r.label} expected: ${r.text}`);
    console.log(`${r.label.padEnd(11)} got:      ${r.recognised.replace(/\n/g, " ⏎ ")}`);
  }
}
console.log(
  `\nRequests to a non-local origin: ${foreign.length === 0 ? "none ✓" : foreign.join(", ")}`,
);
console.log("Per-sample detail: corpus-report/ocr-spike.json (git-ignored)");
