#!/usr/bin/env node
// Placeholder corpus runner. Phase 0 task: implement with the chosen PdfEngine.
// For every PDF in corpus/: open, count pages, render page 1, round-trip through
// packages/core (load → save), re-open, and record timing + failures to
// corpus-report/report.json. Exit non-zero on any regression vs the last report.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../corpus/", import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.toLowerCase().endsWith(".pdf")) files.push(p);
  }
})(root);

console.log(`Found ${files.length} PDFs in corpus/.`);
console.log("Engine not wired yet — implement in Phase 0 (see docs/ROADMAP.md).");
