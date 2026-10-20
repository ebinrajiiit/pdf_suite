import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { RedactArea, RedactRect } from "./redact.js";

/**
 * Finding text by pattern, with boxes tight enough to redact.
 *
 * Redacting personal numbers by hand is how documents leak: a 200-page file
 * with an Aadhaar number on forty of them will be missed on at least one. This
 * finds every occurrence and hands the boxes to the redaction pass, which
 * already removes content and then verifies that it is gone.
 *
 * The boxes come from PDFium's per-character geometry rather than from the
 * search runs the highlighter uses. A run is a whole line, and redacting a line
 * because a phone number is in it would destroy the sentence around it.
 */

/** The patterns offered, written out rather than taken from the user. */
export const PATTERNS = {
  aadhaar: {
    label: "Aadhaar numbers",
    // Twelve digits, usually spaced or hyphenated in fours.
    source: "\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b",
  },
  pan: {
    label: "PAN numbers",
    source: "\\b[A-Z]{5}\\d{4}[A-Z]\\b",
  },
  phone: {
    label: "Phone numbers",
    source: "(?:\\+?91[\\s-]?)?\\b[6-9]\\d{9}\\b",
  },
  email: {
    label: "Email addresses",
    source: "\\b[\\w.%+-]+@[\\w.-]+\\.[A-Za-z]{2,}\\b",
  },
} as const;

export type PatternName = keyof typeof PATTERNS;

/**
 * What to search for: named patterns, and plain words.
 *
 * Words are matched literally, never as a regular expression. A pattern typed
 * by a user would be a regular expression this code then runs over every page —
 * and a carelessly written one can hang the worker. The named patterns are
 * written here and reviewed here; the free-text box escapes what it is given.
 */
export interface FindRequest {
  patterns?: PatternName[];
  /** Matched literally, case-insensitively. */
  words?: string[];
  /** Source page indices to search. Default: every page. */
  pages?: number[];
}

export interface Found {
  areas: RedactArea[];
  /** How many matches, which is what the user is asked to confirm. */
  count: number;
  /** A few examples, for the confirmation — never the whole list. */
  samples: string[];
}

interface Heap {
  malloc(bytes: number): number;
  free(ptr: number): void;
}

function heapOf(m: WrappedPdfiumModule): Heap {
  return {
    malloc(bytes) {
      const ptr = m.pdfium.wasmExports.malloc(bytes);
      if (!ptr) throw new Error(`PDFium could not allocate ${bytes} bytes`);
      return ptr;
    },
    free(ptr) {
      m.pdfium.wasmExports.free(ptr);
    },
  };
}

interface CharBox {
  l: number;
  r: number;
  b: number;
  t: number;
}

/** A page's text with a box for every character of it. */
export function pageCharacters(
  m: WrappedPdfiumModule,
  doc: number,
  pageIndex: number,
): { text: string; boxes: CharBox[] } {
  const heap = heapOf(m);
  const page = m.FPDF_LoadPage(doc, pageIndex);
  if (!page) throw new Error(`could not load page ${pageIndex}`);
  const textPage = m.FPDFText_LoadPage(page);
  if (!textPage) {
    m.FPDF_ClosePage(page);
    return { text: "", boxes: [] };
  }

  const ptr = heap.malloc(32);
  try {
    const count = m.FPDFText_CountChars(textPage);
    let text = "";
    const boxes: CharBox[] = [];
    for (let i = 0; i < count; i++) {
      const code = m.FPDFText_GetUnicode(textPage, i);
      // PDFium reports a box per character; one it cannot place gets a zero box
      // rather than being skipped, so the text and the boxes stay in step.
      const ok = m.FPDFText_GetCharBox(textPage, i, ptr, ptr + 8, ptr + 16, ptr + 24);
      text += code === 0 ? "�" : String.fromCodePoint(code);
      boxes.push(
        ok
          ? {
              l: m.pdfium.getValue(ptr, "double"),
              r: m.pdfium.getValue(ptr + 8, "double"),
              b: m.pdfium.getValue(ptr + 16, "double"),
              t: m.pdfium.getValue(ptr + 24, "double"),
            }
          : { l: 0, r: 0, b: 0, t: 0 },
      );
    }
    return { text, boxes };
  } finally {
    heap.free(ptr);
    m.FPDFText_ClosePage(textPage);
    m.FPDF_ClosePage(page);
  }
}

/** Escapes a word so it is matched as itself, not as a pattern. */
export function literal(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The regular expression a request comes down to, or undefined for none. */
export function expressionFor(request: FindRequest): RegExp | undefined {
  const parts = [
    ...(request.patterns ?? []).map((name) => PATTERNS[name].source),
    ...(request.words ?? []).filter((word) => word.trim() !== "").map((word) => literal(word)),
  ];
  if (parts.length === 0) return undefined;
  return new RegExp(parts.join("|"), "gu");
}

/**
 * Merges the boxes of a matched range into one box per line.
 *
 * A match that wraps across a line end is two boxes, not one tall one covering
 * the text between them — which would black out an innocent line.
 */
export function boxesFor(boxes: CharBox[], from: number, to: number): RedactRect[] {
  const rects: RedactRect[] = [];
  let current: CharBox | undefined;

  for (let i = from; i < to; i++) {
    const box = boxes[i];
    if (!box || (box.r - box.l === 0 && box.t - box.b === 0)) continue;
    // Same line when the boxes overlap vertically by most of their height.
    const sameLine =
      current !== undefined &&
      Math.min(current.t, box.t) - Math.max(current.b, box.b) > (box.t - box.b) * 0.5;
    if (current && sameLine) {
      current = {
        l: Math.min(current.l, box.l),
        r: Math.max(current.r, box.r),
        b: Math.min(current.b, box.b),
        t: Math.max(current.t, box.t),
      };
    } else {
      if (current) rects.push(toRect(current));
      current = { ...box };
    }
  }
  if (current) rects.push(toRect(current));
  return rects;
}

function toRect(box: CharBox): RedactRect {
  // A hair of padding: glyphs overhang their boxes, and a redaction that leaves
  // the top of a digit showing is not a redaction.
  const pad = 0.5;
  return {
    x: box.l - pad,
    y: box.b - pad,
    w: box.r - box.l + pad * 2,
    h: box.t - box.b + pad * 2,
  };
}

/** Finds every match in the document and returns areas ready to redact. */
export function findPattern(
  m: WrappedPdfiumModule,
  doc: number,
  pageCount: number,
  request: FindRequest,
): Found {
  const expression = expressionFor(request);
  if (!expression) return { areas: [], count: 0, samples: [] };

  const pages = request.pages ?? [...Array(pageCount).keys()];
  const areas: RedactArea[] = [];
  const samples: string[] = [];
  let count = 0;

  for (const page of pages) {
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
      throw new RangeError(`page ${page} outside a ${pageCount}-page document`);
    }
    const { text, boxes } = pageCharacters(m, doc, page);
    if (text === "") continue;

    const rects: RedactRect[] = [];
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      const at = match.index ?? 0;
      rects.push(...boxesFor(boxes, at, at + match[0].length));
      count++;
      if (samples.length < 5) samples.push(match[0]);
    }
    if (rects.length > 0) areas.push({ page, rects });
  }

  return { areas, count, samples };
}
