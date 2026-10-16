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
  repaired?: boolean | undefined;
  needsPassword?: boolean | undefined;
  formFields?: number | undefined;
  outlineItems?: number | undefined;
  error?: string | undefined;
}

export interface CorpusConfig {
  pdfiumWasmUrl: string;
  qpdfWasmUrl: string;
  /** Render scale for page 1. */
  scale: number;
}

declare global {
  interface Window {
    runCorpus(files: string[], config: CorpusConfig): Promise<FileResult[]>;
  }
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

      result.textRuns = (await client.pageText(0)).length;

      // Round-trip: save it, then open what we wrote. A document we cannot
      // re-open after writing is the worst kind of regression.
      const t2 = performance.now();
      const saved = await client.save(order, []);
      result.roundTripMs = performance.now() - t2;
      result.reopenedPageCount = (await client.open(saved)).pageCount;
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
