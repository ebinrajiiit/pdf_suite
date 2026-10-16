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

/**
 * A scan is not a clean render: it is skewed, blurred, speckled and JPEG'd. Real
 * scans would be better input, but they come with no ground truth, so accuracy
 * cannot be computed from them. Degrading a page whose text we know is the only
 * way to get an accuracy *number* rather than an impression.
 */
export interface Degradation {
  label: string;
  /** Rotation in degrees, as a sheet sits crooked on the glass. */
  skew: number;
  /** Gaussian-ish blur radius in pixels, for soft focus and photocopying. */
  blur: number;
  /** Fraction of pixels turned into speckle, 0–1. */
  noise: number;
  /** JPEG quality 0–1; scanners rarely hand over lossless images. */
  jpeg: number;
  /** Scan resolution. 300 is the usual floor, 150 is a bad fax. */
  dpi: number;
}

export interface AccuracyResult extends Degradation {
  lang: string;
  accuracy: number;
  confidence: number;
  ms: number;
  error?: string | undefined;
}

declare global {
  interface Window {
    runOcrSpike(assets: OcrAssets, samples: Sample[]): Promise<SampleResult[]>;
    runOcrAccuracy(
      assets: OcrAssets,
      sample: Sample,
      levels: Degradation[],
    ): Promise<AccuracyResult[]>;
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

/** Renders text, then degrades it the way a scanner would. */
async function scanLike(text: string, font: string, level: Degradation): Promise<Blob> {
  const scale = level.dpi / 72;
  const width = Math.round(600 * scale);
  const height = Math.round(160 * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  // Skew about the centre, as a crooked sheet would be.
  ctx.translate(width / 2, height / 2);
  ctx.rotate((level.skew * Math.PI) / 180);
  ctx.translate(-width / 2, -height / 2);
  ctx.fillStyle = "#1a1a1a";
  ctx.font = `${Math.round(18 * scale)}px ${font}`;
  ctx.textBaseline = "middle";
  if (level.blur > 0) ctx.filter = `blur(${level.blur}px)`;
  ctx.fillText(text, 20 * scale, height / 2);
  ctx.restore();
  ctx.filter = "none";

  if (level.noise > 0) {
    const image = ctx.getImageData(0, 0, width, height);
    const { data } = image;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.random() > level.noise) continue;
      // Salt and pepper, which is what dust and toner look like.
      const v = Math.random() < 0.5 ? 0 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
    ctx.putImageData(image, 0, 0);
  }

  return canvas.convertToBlob({ type: "image/jpeg", quality: level.jpeg });
}

window.runOcrAccuracy = async (assets, sample, levels) => {
  const status = document.getElementById("status")!;
  const results: AccuracyResult[] = [];
  const ocr = await createOcr({ ...assets, languages: [sample.lang] });
  try {
    for (const level of levels) {
      status.textContent = `${sample.label} / ${level.label}`;
      const result: AccuracyResult = {
        ...level,
        lang: sample.lang,
        accuracy: 0,
        confidence: 0,
        ms: 0,
      };
      try {
        const image = await scanLike(sample.text, sample.font, level);
        const t0 = performance.now();
        const recognised = await ocr.recognise(image);
        result.ms = performance.now() - t0;
        result.accuracy = similarity(sample.text, recognised.text);
        result.confidence = recognised.confidence;
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      }
      results.push(result);
    }
  } finally {
    await ocr.terminate();
  }
  status.textContent = "done";
  return results;
};

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
