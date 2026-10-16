#!/usr/bin/env node
// Engine spike for ADR 0002: pdf.js vs PDFium-WASM over corpus/.
//
// Serves packages/engine/bench with Vite and drives it in headless Chromium, so
// the numbers come from the real target environment (wasm compile, workers,
// OffscreenCanvas). Corpus bytes are read by the browser from localhost and go
// nowhere else; per-file rows land in corpus-report/ (git-ignored) and only
// aggregates are printed.
//
//   node scripts/bench-engines.mjs [--dir corpus] [--scale 1.5] [--limit N]
//                                   [--engine pdfjs|pdfium] [--synthetic]
//
// Peak memory is the browser process tree's RSS, sampled from here: the in-page
// JS-heap APIs miss pdf.js's worker and PDFium's wasm memory. Pass --engine to
// measure one engine with the other absent; the default runs both, which is what
// the raster comparison needs but blends their footprints.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const benchRoot = join(repoRoot, "packages/engine/bench");
const reportDir = join(repoRoot, "corpus-report");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const scale = Number(flag("scale", "1.5"));
const limit = Number(flag("limit", "0"));
const synthetic = argv.includes("--synthetic");
const engineFlag = flag("engine", "both");
if (!["both", "pdfjs", "pdfium"].includes(engineFlag)) {
  console.error(`--engine must be pdfjs, pdfium or both (got ${engineFlag})`);
  process.exit(2);
}
const engines = engineFlag === "both" ? ["pdfjs", "pdfium"] : [engineFlag];
const corpusDir = resolve(repoRoot, flag("dir", synthetic ? "corpus-report/fixtures" : "corpus"));

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

if (synthetic) {
  const { generateFixtures } = await import("./bench-fixtures.mjs");
  mkdirSync(corpusDir, { recursive: true });
  const n = await generateFixtures(corpusDir);
  console.log(`Generated ${n} synthetic fixtures in ${corpusDir.replace(repoRoot + "/", "")}`);
}

let files = findPdfs(corpusDir);
if (limit > 0) files = files.slice(0, limit);
if (files.length === 0) {
  console.error(
    `No PDFs under ${corpusDir.replace(repoRoot + "/", "")}.\n` +
      "Add the test corpus (see corpus/README.md), or pass --synthetic to run on generated fixtures.",
  );
  process.exit(2);
}
console.log(`Benchmarking ${files.length} PDFs at scale ${scale} with ${engines.join(" + ")}.`);

/** Summed RSS of a pid and its descendants, in bytes. `ps` is everywhere we run. */
function treeRss(rootPid) {
  const lines = execFileSync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n");
  const children = new Map();
  const rss = new Map();
  for (const line of lines) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid)) continue;
    rss.set(pid, (kb || 0) * 1024);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  let total = 0;
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

// Same-origin URLs for every engine asset. Nothing is fetched from a CDN, which
// is also how apps/web will wire these up (docs/PRIVACY.md).
const pdfjsRoot = resolve(require.resolve("pdfjs-dist/package.json", { paths: [benchRoot] }), "..");
const pdfiumWasm = require.resolve("@embedpdf/pdfium/pdfium.wasm", { paths: [benchRoot] });
const fsUrl = (p) => `/@fs${p}`;

const server = await createServer({
  root: benchRoot,
  configFile: false,
  logLevel: "warn",
  server: {
    port: 5199,
    strictPort: true,
    fs: { allow: [repoRoot, corpusDir] },
    // Cross-origin isolation unlocks performance.measureUserAgentSpecificMemory(),
    // which is the only memory API that counts wasm memory as well as the JS heap.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
await server.listen();
const base = `http://localhost:${server.config.server.port}`;

// launchServer (not launch) because only BrowserServer exposes the browser pid,
// which the RSS sampler needs.
const browserServer = await chromium.launchServer({
  args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"],
});
const browser = await chromium.connect(browserServer.wsEndpoint());
const browserPid = browserServer.process()?.pid;
let baselineRss = browserPid ? treeRss(browserPid) : undefined;
let peakRss = baselineRss ?? 0;
const sampler = browserPid
  ? setInterval(() => {
      try {
        peakRss = Math.max(peakRss, treeRss(browserPid));
      } catch {
        // a process exited mid-sample; the next tick will do
      }
    }, 100)
  : undefined;

const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.error("  [page error]", m.text());
});

let report;
try {
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction("typeof window.runBench === 'function'");
  report = await page.evaluate(
    // eslint-disable-next-line no-undef -- this arrow runs in the page, not in node
    ([fileUrls, config]) => window.runBench(fileUrls, config),
    [
      files.map((f) => fsUrl(f)),
      {
        pdfjs: {
          workerSrc: fsUrl(join(pdfjsRoot, "build/pdf.worker.mjs")),
          cMapUrl: fsUrl(join(pdfjsRoot, "cmaps")) + "/",
          standardFontDataUrl: fsUrl(join(pdfjsRoot, "standard_fonts")) + "/",
          wasmUrl: fsUrl(join(pdfjsRoot, "wasm")) + "/",
          iccUrl: fsUrl(join(pdfjsRoot, "iccs")) + "/",
        },
        pdfiumWasmUrl: fsUrl(pdfiumWasm),
        scale,
        engines,
      },
    ],
  );
} finally {
  if (sampler) clearInterval(sampler);
  await browser.close();
  await browserServer.close();
  await server.close();
}

// ---- aggregate ----
const median = (xs) => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const p95 = (xs) => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};
const fmt = (x, unit = "ms") => (x === undefined ? "—" : `${x.toFixed(x < 10 ? 1 : 0)}${unit}`);
const mb = (x) => (x === undefined ? "—" : `${(x / 1024 / 1024).toFixed(1)} MB`);

const summarise = (engine) => {
  const rows = report.results.filter((r) => r.engine === engine);
  const ok = rows.filter((r) => !r.error);
  const pick = (key) => ok.map((r) => r[key]).filter((v) => typeof v === "number");
  return {
    engine,
    files: rows.length,
    failed: rows.length - ok.length,
    openMedian: median(pick("openMs")),
    openP95: p95(pick("openMs")),
    renderMedian: median(pick("renderMs")),
    renderP95: p95(pick("renderMs")),
    textMedian: median(pick("textMs")),
    pageSizesMedian: median(pick("pageSizesMs")),
    pageSizesMax: Math.max(0, ...pick("pageSizesMs")) || undefined,
    memPeak: Math.max(0, ...pick("memBytes")) || undefined,
    wasmHeapPeak: Math.max(0, ...pick("wasmHeapBytes")) || undefined,
    charsTotal: pick("textChars").reduce((a, b) => a + b, 0),
    errors: rows
      .filter((r) => r.error)
      .reduce((acc, r) => ((acc[r.error] = (acc[r.error] ?? 0) + 1), acc), {}),
  };
};

const summary = {
  generatedAt: new Date().toISOString(),
  enginesRun: engines,
  peakBrowserRssBytes: peakRss || undefined,
  baselineBrowserRssBytes: baselineRss || undefined,
  corpus: { dir: corpusDir.replace(repoRoot + "/", ""), files: files.length, synthetic },
  scale,
  memoryApi: report.memoryApi,
  initMs: report.initMs,
  engines: engines.map(summarise),
  agreement: {
    compared: report.pairs.filter((p) => typeof p.pixelDiff === "number").length,
    dimsMismatch: report.pairs.filter((p) => p.dimsMismatch).length,
    bothFailedOrOne: report.pairs.filter((p) => p.note).length,
    medianPixelDiff: median(report.pairs.map((p) => p.pixelDiff).filter((x) => x !== undefined)),
    over2pct: report.pairs.filter((p) => (p.pixelDiff ?? 0) > 0.02).length,
  },
};

mkdirSync(reportDir, { recursive: true });
writeFileSync(
  join(reportDir, "engine-bench.json"),
  JSON.stringify({ summary, ...report }, null, 2),
);
writeFileSync(join(reportDir, "engine-bench-summary.json"), JSON.stringify(summary, null, 2));

console.log(
  `\npeak browser RSS: ${mb(peakRss)} (baseline ${mb(baselineRss)}, ` +
    `delta ${mb(peakRss - (baselineRss ?? 0))}) for ${engines.join(" + ")}`,
);
console.log(`in-page memory API: ${report.memoryApi}`);
console.log(
  `engine init: pdf.js ${fmt(report.initMs.pdfjs)} (worker is lazy), ` +
    `PDFium ${fmt(report.initMs.pdfium)} (wasm compile)`,
);
console.log("\nengine   files  fail  open med/p95      render med/p95     text med   peak mem");
for (const s of summary.engines) {
  console.log(
    `${s.engine.padEnd(8)} ${String(s.files).padStart(5)} ${String(s.failed).padStart(5)}  ` +
      `${fmt(s.openMedian).padStart(7)}/${fmt(s.openP95).padEnd(8)} ` +
      `${fmt(s.renderMedian).padStart(7)}/${fmt(s.renderP95).padEnd(8)} ` +
      `${fmt(s.textMedian).padStart(8)}  ${mb(s.memPeak).padStart(9)}`,
  );
}
const pdfjs = summary.engines.find((s) => s.engine === "pdfjs");
if (pdfjs?.pageSizesMedian !== undefined) {
  console.log(
    `\npdf.js page-size prefetch inside open(): median ${fmt(pdfjs.pageSizesMedian)}, ` +
      `max ${fmt(pdfjs.pageSizesMax)}`,
  );
}
const pdfium = summary.engines.find((s) => s.engine === "pdfium");
if (pdfium?.wasmHeapPeak) console.log(`PDFium wasm linear memory peak: ${mb(pdfium.wasmHeapPeak)}`);
console.log(
  `\nrasters compared: ${summary.agreement.compared}, median pixel difference ` +
    `${summary.agreement.medianPixelDiff === undefined ? "—" : (summary.agreement.medianPixelDiff * 100).toFixed(2) + "%"}` +
    `, over 2%: ${summary.agreement.over2pct}, size mismatch: ${summary.agreement.dimsMismatch}`,
);
console.log(
  "text extracted (chars): " + summary.engines.map((s) => `${s.engine} ${s.charsTotal}`).join(", "),
);
for (const s of summary.engines) {
  for (const [message, count] of Object.entries(s.errors)) {
    console.log(`  ${s.engine} failure x${count}: ${message}`);
  }
}
console.log(`\nPer-file rows: corpus-report/engine-bench.json (git-ignored)`);
