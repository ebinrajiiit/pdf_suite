#!/usr/bin/env node
// Downloads Tesseract language data into a git-ignored vendor directory.
//
// These files are NOT committed: they are large, and `corpus/`-style binaries do
// not belong in the repo. For a release they must be self-hosted — either in the
// bundle or as an opt-in one-time download from our own host, which is the only
// form docs/PRIVACY.md allows. tesseract.js would otherwise fetch them from
// jsDelivr, which privacy invariants 2 and 3 forbid.
//
//   node scripts/fetch-tessdata.mjs [eng mal hin ...] [--variant fast|standard|best]
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const variantIndex = argv.indexOf("--variant");
const variant = variantIndex === -1 ? "fast" : argv[variantIndex + 1];
const langs = argv.filter((a) => !a.startsWith("--") && a !== variant);
const wanted = langs.length > 0 ? langs : ["eng", "mal", "hin"];

const REPOS = {
  fast: "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main",
  standard: "https://raw.githubusercontent.com/tesseract-ocr/tessdata/main",
  best: "https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main",
};
const base = REPOS[variant];
if (!base) {
  console.error(`--variant must be one of ${Object.keys(REPOS).join(", ")}`);
  process.exit(2);
}

const outDir = resolve(import.meta.dirname, "..", "vendor", "tessdata", variant);
mkdirSync(outDir, { recursive: true });

console.log(`Fetching ${wanted.join(", ")} (${variant}) into vendor/tessdata/${variant}`);
const report = [];
for (const lang of wanted) {
  const file = join(outDir, `${lang}.traineddata`);
  if (existsSync(file)) {
    console.log(`  ${lang}: already present (${(statSync(file).size / 1048576).toFixed(1)} MB)`);
    report.push({ lang, bytes: statSync(file).size, cached: true });
    continue;
  }
  const url = `${base}/${lang}.traineddata`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  ${lang}: HTTP ${res.status} from ${url}`);
    process.exitCode = 1;
    continue;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  console.log(`  ${lang}: ${(bytes.length / 1048576).toFixed(1)} MB  sha256:${sha.slice(0, 16)}…`);
  report.push({ lang, bytes: bytes.length, sha256: sha });
}

console.log(
  `\nTotal ${(report.reduce((n, r) => n + r.bytes, 0) / 1048576).toFixed(1)} MB. ` +
    "Apache-2.0 (tesseract-ocr/tessdata*) — recorded in scripts/third-party.json.",
);
