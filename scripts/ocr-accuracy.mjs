#!/usr/bin/env node
// Measures OCR accuracy against degradation, for ADR 0004.
//
// Real scans would be better input, but they carry no ground truth, so no
// accuracy can be computed from them — only an impression. Degrading a page
// whose text we know gives a number, and shows where accuracy falls off: skew,
// blur, speckle, JPEG quality and resolution, one at a time.
//
//   node scripts/fetch-tessdata.mjs        # once
//   node scripts/ocr-accuracy.mjs [--lang eng]
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const benchRoot = join(repoRoot, "packages/ocr/bench");
const argv = process.argv.slice(2);
const lang = argv.includes("--lang") ? argv[argv.indexOf("--lang") + 1] : "eng";
const langDir = join(repoRoot, "vendor/tessdata/fast");

if (!existsSync(langDir)) {
  console.error("No language data. Run: node scripts/fetch-tessdata.mjs");
  process.exit(2);
}

const SAMPLES = {
  eng: {
    lang: "eng",
    label: "English",
    text: "Result sheet for semester one 2026, candidate 41827",
    font: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  mal: {
    lang: "mal",
    label: "Malayalam",
    text: "കേരള സർവകലാശാല പരീക്ഷാ ഫലം",
    font: '"Malayalam MN", "Nirmala UI", "Noto Sans Malayalam", sans-serif',
  },
  hin: {
    lang: "hin",
    label: "Hindi",
    text: "परीक्षा परिणाम विद्यार्थी का नाम",
    font: '"Devanagari MT", "Nirmala UI", "Noto Sans Devanagari", sans-serif',
  },
};

// One axis at a time, so a drop can be attributed rather than guessed at.
const LEVELS = [
  { label: "clean 300dpi", skew: 0, blur: 0, noise: 0, jpeg: 1, dpi: 300 },
  { label: "jpeg 60%", skew: 0, blur: 0, noise: 0, jpeg: 0.6, dpi: 300 },
  { label: "skew 1.5deg", skew: 1.5, blur: 0, noise: 0, jpeg: 0.9, dpi: 300 },
  { label: "skew 5deg", skew: 5, blur: 0, noise: 0, jpeg: 0.9, dpi: 300 },
  { label: "blur 1px", skew: 0, blur: 1, noise: 0, jpeg: 0.9, dpi: 300 },
  { label: "blur 2px", skew: 0, blur: 2, noise: 0, jpeg: 0.9, dpi: 300 },
  { label: "speckle 2%", skew: 0, blur: 0, noise: 0.02, jpeg: 0.9, dpi: 300 },
  { label: "speckle 8%", skew: 0, blur: 0, noise: 0.08, jpeg: 0.9, dpi: 300 },
  { label: "150dpi", skew: 0, blur: 0, noise: 0, jpeg: 0.9, dpi: 150 },
  { label: "bad photocopy", skew: 2, blur: 1.5, noise: 0.04, jpeg: 0.5, dpi: 200 },
];

const sample = SAMPLES[lang];
if (!sample) {
  console.error(`--lang must be one of ${Object.keys(SAMPLES).join(", ")}`);
  process.exit(2);
}

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
  server: { port: 5196, strictPort: true, fs: { allow: [repoRoot] } },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.error("  [page]", m.text().slice(0, 140));
});

let results;
try {
  await page.goto("http://localhost:5196", { waitUntil: "load" });
  await page.waitForFunction("typeof window.runOcrAccuracy === 'function'");
  results = await page.evaluate(
    // eslint-disable-next-line no-undef -- this arrow runs in the page, not in node
    ([assets, s, levels]) => window.runOcrAccuracy(assets, s, levels),
    [
      {
        workerPath: fsUrl(join(tesseractDir, "dist/worker.min.js")),
        corePath: `${fsUrl(coreDir)}/`,
        langPath: `${fsUrl(langDir)}/`,
      },
      sample,
      LEVELS,
    ],
  );
} finally {
  await browser.close();
  await server.close();
}

mkdirSync(join(repoRoot, "corpus-report"), { recursive: true });
writeFileSync(
  join(repoRoot, "corpus-report", `ocr-accuracy-${lang}.json`),
  JSON.stringify({ generatedAt: new Date().toISOString(), sample, results }, null, 2),
);

console.log(`\n${sample.label} (${sample.lang}), ground truth known\n`);
console.log("degradation        accuracy  confidence   time");
for (const r of results) {
  const bar = "#".repeat(Math.round(r.accuracy * 20)).padEnd(20, ".");
  console.log(
    `${r.label.padEnd(18)} ${`${(r.accuracy * 100).toFixed(0)}%`.padStart(7)}  ` +
      `${r.confidence.toFixed(0).padStart(9)}  ${`${r.ms.toFixed(0)}ms`.padStart(6)}  ${bar}`,
  );
  if (r.error) console.log(`  error: ${r.error}`);
}
const usable = results.filter((r) => r.accuracy >= 0.95).length;
console.log(
  `\n${usable}/${results.length} degradations stayed at or above 95% accuracy. ` +
    "Report: corpus-report/ocr-accuracy-" +
    lang +
    ".json",
);
