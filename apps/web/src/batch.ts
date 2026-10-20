import {
  createPdfWorkerClient,
  type PdfWorkerClient,
  type StampOptions,
  type WatermarkOptions,
} from "@pdf-suite/workers";
import pdfiumWasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import qpdfWasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";
import type { PickedFile } from "./file-io.js";

/**
 * The same operation over many files — Acrobat's Action Wizard, for the
 * actions an institution repeats.
 *
 * Numbering two hundred grade cards, stamping a watermark on every circular in
 * a folder, stripping the metadata off a batch before they go out: each is one
 * operation applied to a pile, and doing it by hand is where the one that was
 * missed comes from.
 *
 * It runs in a worker of its own. The one the app uses holds the open
 * document, and a batch has no business disturbing what someone is working on.
 */

export type BatchAction =
  | { kind: "number"; options: StampOptions }
  | { kind: "watermark"; options: WatermarkOptions }
  | { kind: "sanitise" }
  | { kind: "compress" }
  | { kind: "redact"; patterns: ("aadhaar" | "pan" | "phone" | "email")[] };

export interface BatchResult {
  name: string;
  /** The finished document, or undefined when it failed. */
  bytes?: ArrayBuffer | undefined;
  /** What happened, in words: "3 matches removed", or why it did not. */
  note: string;
  failed: boolean;
}

export interface BatchProgress {
  done: number;
  total: number;
  name: string;
}

/**
 * Runs one action over each file in turn, and reports what happened to each.
 *
 * A file that fails does not stop the batch: a folder of two hundred where one
 * is damaged should produce a hundred and ninety-nine finished documents and a
 * line saying which one did not, rather than nothing at all.
 */
export async function runBatch(
  files: PickedFile[],
  action: BatchAction,
  onProgress?: (progress: BatchProgress) => void,
): Promise<BatchResult[]> {
  const worker: PdfWorkerClient = createPdfWorkerClient();
  const results: BatchResult[] = [];

  try {
    const wasm = await (await fetch(pdfiumWasmUrl)).arrayBuffer();
    await worker.init(wasm, new URL(qpdfWasmUrl, location.href).href);

    for (const [index, file] of files.entries()) {
      onProgress?.({ done: index, total: files.length, name: file.name });
      try {
        const info = await worker.open(file.bytes);
        const order = info.pageSizes.map((_, page) => page);
        let note = "done";

        switch (action.kind) {
          case "number":
            await worker.stamp(action.options, order, []);
            note = `numbered ${order.length} page${order.length === 1 ? "" : "s"}`;
            break;
          case "watermark":
            await worker.watermark(action.options, order, []);
            note = "watermarked";
            break;
          case "sanitise": {
            const { removed } = await worker.sanitise(
              { metadata: true, attachments: true, scripts: true },
              order,
              [],
            );
            const went = (removed.metadata ? 1 : 0) + removed.attachments + removed.scripts;
            note = went === 0 ? "nothing hidden to remove" : `removed ${went} hidden item(s)`;
            break;
          }
          case "compress":
            await worker.compress(order, []);
            note = "compressed";
            break;
          case "redact": {
            const found = await worker.findPattern({ patterns: action.patterns }, order, []);
            if (found.count === 0) {
              note = "nothing matched";
              break;
            }
            const result = await worker.redact(found.areas, order, []);
            note = result.verified
              ? `removed ${found.count} match${found.count === 1 ? "" : "es"}`
              : `WARNING: ${found.count} match(es) marked but text remains — do not share`;
            break;
          }
        }

        results.push({ name: file.name, bytes: await worker.save(order, []), note, failed: false });
      } catch (error) {
        results.push({
          name: file.name,
          note: error instanceof Error ? error.message : String(error),
          failed: true,
        });
      }
    }
    onProgress?.({ done: files.length, total: files.length, name: "" });
  } finally {
    // One worker for the batch, closed whatever happened: a leaked worker
    // holds a PDFium heap for the life of the page.
    worker.terminate();
  }

  return results;
}
