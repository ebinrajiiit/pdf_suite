// OCR spike for ADR 0004, driven by scripts/ocr-spike.mjs.
//
// Renders known text to a canvas with a system font, runs Tesseract over it, and
// reports how much of the text came back. Generated images are a weaker test
// than real scans — no skew, no noise, no JPEG artefacts — so these numbers are
// an upper bound, and the Indic ones only mean anything if the browser actually
// has a font for the script, which the report states.
import { createOcr, type OcrAssets } from "../src/index.js";

export interface Sample {
  lang: string;
  label: string;
  text: string;
  /** Font stack to render with; the report says whether it was available. */
  font: string;
}

export interface SampleResult extends Sample {
  fontAvailable: boolean;
  recognised: string;
  confidence: number;
  words: number;
  accuracy: number;
  initMs: number;
  recogniseMs: number;
  pdfBytes?: number | undefined;
  pdfHasText?: boolean | undefined;
  error?: string | undefined;
}

declare global {
  interface Window {
    runOcrSpike(assets: OcrAssets, samples: Sample[]): Promise<SampleResult[]>;
  }
}

/** Levenshtein-based similarity, 0–1, so a near miss is not scored as a failure. */
function similarity(expected: string, got: string): number {
  const a = expected.replace(/\s+/g, " ").trim();
  const b = got.replace(/\s+/g, " ").trim();
  if (a === "") return b === "" ? 1 : 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = new Array<number>(cols);
  let current = new Array<number>(cols);
  for (let j = 0; j < cols; j++) previous[j] = j;
  for (let i = 1; i < rows; i++) {
    current[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return Math.max(0, 1 - previous[cols - 1]! / Math.max(a.length, b.length));
}

/**
 * True when the browser has a real font for this text. Measured by comparing the
 * text's width against the same string in a font that certainly does not exist:
 * identical widths mean both fell back to the same tofu glyphs.
 */
function hasFont(text: string, font: string): boolean {
  const canvas = new OffscreenCanvas(10, 10);
  const ctx = canvas.getContext("2d")!;
  ctx.font = `32px ${font}`;
  const withFont = ctx.measureText(text).width;
  ctx.font = '32px "No Such Font At All"';
  const fallback = ctx.measureText(text).width;
  return Math.abs(withFont - fallback) > 0.5;
}

/** Black text on white, at a generous size: the best case for OCR. */
function render(text: string, font: string): OffscreenCanvas {
  const scale = 3;
  const canvas = new OffscreenCanvas(1000 * scale, 150 * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.font = `${36 * scale}px ${font}`;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 20 * scale, 75 * scale);
  return canvas;
}

window.runOcrSpike = async (assets, samples) => {
  const status = document.getElementById("status")!;
  const results: SampleResult[] = [];

  for (const sample of samples) {
    status.textContent = `${sample.label}…`;
    const result: SampleResult = {
      ...sample,
      fontAvailable: hasFont(sample.text, sample.font),
      recognised: "",
      confidence: 0,
      words: 0,
      accuracy: 0,
      initMs: 0,
      recogniseMs: 0,
    };
    try {
      const image = render(sample.text, sample.font);
      const t0 = performance.now();
      const ocr = await createOcr({ ...assets, languages: [sample.lang] });
      result.initMs = performance.now() - t0;

      const t1 = performance.now();
      const recognised = await ocr.recognise(image);
      result.recogniseMs = performance.now() - t1;
      result.recognised = recognised.text.trim();
      result.confidence = recognised.confidence;
      result.words = recognised.words.length;
      result.accuracy = similarity(sample.text, recognised.text);

      // Does Tesseract's own searchable-PDF output work in the browser build?
      try {
        const pdf = await ocr.recogniseToPdf(image);
        result.pdfBytes = pdf.byteLength;
        const head = new TextDecoder("latin1").decode(pdf.subarray(0, 2048));
        result.pdfHasText = head.startsWith("%PDF");
      } catch (err) {
        result.pdfBytes = 0;
        result.pdfHasText = false;
        result.error = `pdf output: ${err instanceof Error ? err.message : String(err)}`;
      }

      await ocr.terminate();
    } catch (err) {
      result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    results.push(result);
  }

  status.textContent = "done";
  return results;
};
