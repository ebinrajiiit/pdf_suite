// Benchmark page for ADR 0002. Driven by scripts/bench-engines.mjs, which serves
// this directory with Vite and runs it in headless Chromium — the real target
// environment, so the numbers include wasm compilation and worker overhead.
//
// Corpus bytes are fetched from the local dev server and never leave the page.
import { createPdfiumEngine, type PdfiumEngine } from "../src/pdfium/index.js";
import { createPdfjsEngine } from "../src/pdfjs/index.js";
import type { DocHandle, PdfEngine } from "../src/index.js";

export interface BenchConfig {
  /** Same-origin URLs for every engine asset; see scripts/bench-engines.mjs. */
  pdfjs: {
    workerSrc: string;
    cMapUrl: string;
    standardFontDataUrl: string;
    wasmUrl: string;
    iccUrl: string;
  };
  pdfiumWasmUrl: string;
  scale: number;
  /** Which engines to run. One at a time gives a clean process-level memory
   *  reading; both together is what the raster comparison needs. */
  engines: ("pdfjs" | "pdfium")[];
}

export interface FileResult {
  file: string;
  bytes: number;
  engine: "pdfjs" | "pdfium";
  openMs?: number | undefined;
  parseMs?: number | undefined;
  pageSizesMs?: number | undefined;
  renderMs?: number | undefined;
  textMs?: number | undefined;
  pageCount?: number | undefined;
  textRuns?: number | undefined;
  textChars?: number | undefined;
  pageWidthPt?: number | undefined;
  renderedPx?: [number, number] | undefined;
  memBytes?: number | undefined;
  wasmHeapBytes?: number | undefined;
  error?: string | undefined;
}

export interface PairResult {
  file: string;
  /** Mean absolute RGB difference between the two engines' page 1, 0–1. */
  pixelDiff?: number | undefined;
  dimsMismatch?: boolean | undefined;
  note?: string | undefined;
}

export interface BenchReport {
  initMs: { pdfjs: number; pdfium: number };
  memoryApi: "measureUserAgentSpecificMemory" | "usedJSHeapSize" | "none";
  results: FileResult[];
  pairs: PairResult[];
}

type Measure = () => Promise<number | undefined>;
type Timings = { parse?: number | undefined; pageSizes?: number | undefined };

declare global {
  interface Window {
    runBench(files: string[], config: BenchConfig): Promise<BenchReport>;
  }
}

function memoryProbe(): { api: () => BenchReport["memoryApi"]; measure: Measure } {
  const perf = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    memory?: { usedJSHeapSize: number };
  };
  // Chrome gates measureUserAgentSpecificMemory behind cross-origin isolation and
  // does not ship it in every build, so fall back the first time it refuses.
  // usedJSHeapSize is JS-heap only: it misses the wasm linear memory that is most
  // of PDFium's footprint, which is why the report names the API it used.
  let api: BenchReport["memoryApi"] =
    crossOriginIsolated && perf.measureUserAgentSpecificMemory
      ? "measureUserAgentSpecificMemory"
      : perf.memory
        ? "usedJSHeapSize"
        : "none";

  const measure: Measure = async () => {
    if (api === "measureUserAgentSpecificMemory") {
      try {
        return (await perf.measureUserAgentSpecificMemory!()).bytes;
      } catch {
        api = perf.memory ? "usedJSHeapSize" : "none";
      }
    }
    return api === "usedJSHeapSize" ? perf.memory!.usedJSHeapSize : undefined;
  };

  return { api: () => api, measure };
}

async function collectGarbage(): Promise<void> {
  (globalThis as { gc?: () => void }).gc?.();
  await new Promise((r) => setTimeout(r, 0));
}

async function imageData(bitmap: ImageBitmap): Promise<ImageData> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D context");
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/** Mean absolute RGB difference, ignoring alpha. Not fidelity against ground
 *  truth — it flags the pages where the engines disagree enough to look at. */
async function compare(a: ImageBitmap, b: ImageBitmap): Promise<PairResult["pixelDiff"]> {
  const [ia, ib] = await Promise.all([imageData(a), imageData(b)]);
  let sum = 0;
  for (let i = 0; i < ia.data.length; i += 4) {
    sum += Math.abs(ia.data[i]! - ib.data[i]!);
    sum += Math.abs(ia.data[i + 1]! - ib.data[i + 1]!);
    sum += Math.abs(ia.data[i + 2]! - ib.data[i + 2]!);
  }
  return sum / ((ia.data.length / 4) * 3 * 255);
}

async function measureOne(
  engineName: FileResult["engine"],
  engine: PdfEngine,
  file: string,
  bytes: ArrayBuffer,
  config: BenchConfig,
  timings: Timings,
  probe: Measure,
  wasmHeap: () => number | undefined,
): Promise<{ result: FileResult; bitmap?: ImageBitmap }> {
  const result: FileResult = { file, bytes: bytes.byteLength, engine: engineName };
  let doc: DocHandle | undefined;
  let bitmap: ImageBitmap | undefined;
  try {
    timings.parse = undefined;
    timings.pageSizes = undefined;

    const t0 = performance.now();
    doc = await engine.open(bytes);
    result.openMs = performance.now() - t0;
    result.parseMs = timings.parse;
    result.pageSizesMs = timings.pageSizes;
    result.pageCount = doc.pageCount();
    result.pageWidthPt = doc.pageSize(0).width;

    const t1 = performance.now();
    bitmap = await doc.renderPage(0, config.scale);
    result.renderMs = performance.now() - t1;
    result.renderedPx = [bitmap.width, bitmap.height];

    const t2 = performance.now();
    const runs = await doc.extractText(0);
    result.textMs = performance.now() - t2;
    result.textRuns = runs.length;
    result.textChars = runs.reduce((n, r) => n + r.text.length, 0);

    result.memBytes = await probe();
    result.wasmHeapBytes = wasmHeap();
  } catch (err) {
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } finally {
    doc?.close();
  }
  return bitmap ? { result, bitmap } : { result };
}

window.runBench = async (files, config) => {
  const status = document.getElementById("status")!;
  const { api, measure } = memoryProbe();

  const pdfjsTimings: Timings = {};
  const pdfiumTimings: Timings = {};

  const wanted = new Set(config.engines);

  let pdfjs: PdfEngine | undefined;
  let initPdfjs = 0;
  if (wanted.has("pdfjs")) {
    const t = performance.now();
    pdfjs = createPdfjsEngine({
      ...config.pdfjs,
      onTiming: (phase, ms) => (pdfjsTimings[phase] = ms),
    });
    // pdf.js spawns its worker lazily, so this only covers wiring; the first
    // open() pays for the worker.
    initPdfjs = performance.now() - t;
  }

  let pdfium: PdfiumEngine | undefined;
  let initPdfium = 0;
  if (wanted.has("pdfium")) {
    const t = performance.now();
    const wasm = await (await fetch(config.pdfiumWasmUrl)).arrayBuffer();
    pdfium = await createPdfiumEngine({
      wasmBinary: wasm,
      onTiming: (phase, ms) => (pdfiumTimings[phase] = ms),
    });
    // Compiling the wasm happens here, not on first open.
    initPdfium = performance.now() - t;
  }

  const report: BenchReport = {
    initMs: { pdfjs: initPdfjs, pdfium: initPdfium },
    memoryApi: api(),
    results: [],
    pairs: [],
  };

  for (const [i, file] of files.entries()) {
    status.textContent = `${i + 1}/${files.length}`;
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(file);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      bytes = await res.arrayBuffer();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.results.push({ file, bytes: 0, engine: "pdfjs", error: `fetch failed: ${message}` });
      continue;
    }

    let a: { result: FileResult; bitmap?: ImageBitmap } = {
      result: { file, bytes: 0, engine: "pdfjs" },
    };
    if (pdfjs) {
      await collectGarbage();
      a = await measureOne(
        "pdfjs",
        pdfjs,
        file,
        bytes,
        config,
        pdfjsTimings,
        measure,
        () => undefined,
      );
      report.results.push(a.result);
    }

    let b: { result: FileResult; bitmap?: ImageBitmap } = {
      result: { file, bytes: 0, engine: "pdfium" },
    };
    if (pdfium) {
      await collectGarbage();
      const engine = pdfium;
      b = await measureOne("pdfium", engine, file, bytes, config, pdfiumTimings, measure, () =>
        engine.wasmHeapBytes(),
      );
      report.results.push(b.result);
    }

    const pair: PairResult = { file };
    if (a.bitmap && b.bitmap) {
      if (a.bitmap.width !== b.bitmap.width || a.bitmap.height !== b.bitmap.height) {
        pair.dimsMismatch = true;
      } else {
        pair.pixelDiff = await compare(a.bitmap, b.bitmap);
      }
    } else if (wanted.size < 2) {
      pair.note = "single-engine run";
    } else {
      pair.note = "one or both engines failed";
    }
    report.pairs.push(pair);
    a.bitmap?.close();
    b.bitmap?.close();
  }

  report.memoryApi = api();
  status.textContent = "done";
  return report;
};
