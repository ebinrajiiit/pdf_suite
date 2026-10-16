// Corpus regression runner, driven by scripts/corpus-runner.mjs.
//
// It drives the real worker client rather than bespoke test code, so what is
// measured is the pipeline the app uses: open (with repair-on-open), render,
// round-trip through packages/core, and re-open the result. A file that opens
// today and fails tomorrow is a regression, which is the Phase 1 gate.
import { createPdfWorkerClient } from "../src/index.js";

export interface FileResult {
  file: string;
  bytes: number;
  pageCount?: number | undefined;
  openMs?: number | undefined;
  renderMs?: number | undefined;
  roundTripMs?: number | undefined;
  reopenedPageCount?: number | undefined;
  textRuns?: number | undefined;
  /** Share of extracted characters per script, as whole percentages. */
  textScripts?: Record<string, number> | undefined;
  repaired?: boolean | undefined;
  needsPassword?: boolean | undefined;
  formFields?: number | undefined;
  outlineItems?: number | undefined;
  /** Set when this file had no text layer and OCR was run over page 1. */
  ocr?:
    | {
        ms: number;
        chars: number;
        runs: number;
        /** Share of characters in each script, so Indic output is visible. */
        scripts: Record<string, number>;
      }
    | undefined;
  error?: string | undefined;
}

export interface CorpusConfig {
  pdfiumWasmUrl: string;
  qpdfWasmUrl: string;
  /** Render scale for page 1. */
  scale: number;
  /**
   * When set, pages with no text layer are run through OCR. There is no ground
   * truth for a real scan, so this measures what came back — how much text, at
   * what confidence, and in which scripts — not accuracy.
   */
  ocr?: {
    languages: string[];
    assets: { workerPath: string; corePath: string; langPath: string };
  };
}

declare global {
  interface Window {
    runCorpus(files: string[], config: CorpusConfig): Promise<FileResult[]>;
  }
}

/** Characters per script, as whole percentages. No text is reported, only shape. */
function scriptMix(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const ch of text.replace(/\s/g, "")) {
    const code = ch.codePointAt(0) ?? 0;
    const script =
      code >= 0x0d00 && code <= 0x0d7f
        ? "malayalam"
        : code >= 0x0900 && code <= 0x097f
          ? "devanagari"
          : code >= 0x0041 && code <= 0x007a
            ? "latin"
            : code >= 0x0030 && code <= 0x0039
              ? "digits"
              : "other";
    counts[script] = (counts[script] ?? 0) + 1;
    total++;
  }
  if (total === 0) return {};
  for (const key of Object.keys(counts)) {
    counts[key] = Math.round(((counts[key] ?? 0) / total) * 100);
  }
  return counts;
}

window.runCorpus = async (files, config) => {
  const status = document.getElementById("status")!;
  const client = createPdfWorkerClient();
  const wasm = await (await fetch(config.pdfiumWasmUrl)).arrayBuffer();
  await client.init(wasm, config.qpdfWasmUrl);

  const results: FileResult[] = [];
  for (const [index, file] of files.entries()) {
    status.textContent = `${index + 1}/${files.length}`;
    const result: FileResult = { file, bytes: 0 };
    try {
      const bytes = await (await fetch(file)).arrayBuffer();
      result.bytes = bytes.byteLength;

      const t0 = performance.now();
      const info = await client.open(bytes);
      result.openMs = performance.now() - t0;
      result.pageCount = info.pageCount;
      result.repaired = info.repaired ?? false;
      result.formFields = info.form.fields.length;
      result.outlineItems = info.outline.length;

      const order = info.pageSizes.map((_, i) => i);

      const t1 = performance.now();
      const bitmap = await client.render(0, config.scale);
      result.renderMs = performance.now() - t1;
      bitmap.close();

      const runs = await client.pageText(0);
      result.textRuns = runs.length;
      // Which scripts the *extracted* text is in. This is how Indic extraction
      // gets verified on real documents, separately from OCR.
      result.textScripts = scriptMix(runs.map((r) => r.text).join(""));

      // Round-trip: save it, then open what we wrote. A document we cannot
      // re-open after writing is the worst kind of regression.
      const t2 = performance.now();
      const saved = await client.save(order, []);
      result.roundTripMs = performance.now() - t2;
      result.reopenedPageCount = (await client.open(saved)).pageCount;

      // A page with no text is a scan. Running the shipped OCR path over it is
      // the only way to see what Tesseract does with real Malayalam.
      if (config.ocr && result.textRuns === 0) {
        const t3 = performance.now();
        // Despeckled, since that is what the app does by default (ADR 0004).
        await client.ocr([0], [0], [], config.ocr.languages, config.ocr.assets, true);
        const ocrRuns = await client.pageText(0);
        const text = ocrRuns.map((r) => r.text).join("");
        result.ocr = {
          ms: performance.now() - t3,
          chars: text.replace(/\s/g, "").length,
          runs: ocrRuns.length,
          scripts: scriptMix(text),
        };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "PasswordRequiredError") {
        // Not a failure: an encrypted file in the corpus is expected to ask.
        result.needsPassword = true;
      } else {
        result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
    }
    results.push(result);
  }

  client.terminate();
  status.textContent = "done";
  return results;
};
