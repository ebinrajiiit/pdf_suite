import type { TextRun } from "./types.js";

/** A box in PDF points, origin at the page's bottom-left. */
export interface SearchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SearchMatch {
  /** Index of the run the match was found in. */
  run: number;
  /** The run's text, for showing the match in context. */
  snippet: string;
  /** Offset of the match within the folded run text. */
  at: number;
  /**
   * Boxes to highlight.
   *
   * ponytail: this is the whole run — which is a line for both adapters — not
   * the matched substring, because `TextRun` carries no per-character geometry.
   * Estimating the substring box proportionally would misplace it on Malayalam
   * and Hindi, where one cluster is several characters, and Indic text is
   * first-class here (CLAUDE.md §4). Narrow it by exposing glyph quads from the
   * engines (FPDFText_GetCharBox, pdf.js glyph offsets) and mapping offsets to
   * them.
   */
  rects: SearchRect[];
}

/**
 * Malayalam chillu letters, which have two equally correct spellings: an atomic
 * code point, and the base consonant plus virama plus ZWJ. Unicode does not
 * reconcile them — neither NFC nor NFKC — so matching has to.
 *
 * This is not theoretical: the OCR spike (ADR 0004) read കേരള സർവകലാശാല and
 * returned the ZWJ spelling, which would never have matched a query typed with
 * the atomic letters.
 */
const CHILLU: [RegExp, string][] = [
  [/\u0D7A/g, "\u0D23\u0D4D"], // ൺ -> ണ്
  [/\u0D7B/g, "\u0D28\u0D4D"], // ൻ -> ന്
  [/\u0D7C/g, "\u0D30\u0D4D"], // ർ -> ര്
  [/\u0D7D/g, "\u0D32\u0D4D"], // ൽ -> ല്
  [/\u0D7E/g, "\u0D33\u0D4D"], // ൾ -> ള്
  [/\u0D7F/g, "\u0D15\u0D4D"], // ൿ -> ക്
];

/**
 * Case- and spelling-insensitive folding.
 *
 * Unicode normalisation matters more than case here: Indic text extracted from a
 * PDF may arrive decomposed while the query is typed composed, or the reverse,
 * and the two are the same word to a reader. On top of NFC this strips the
 * zero-width joiners that only affect shaping, and rewrites atomic Malayalam
 * chillus into their base-plus-virama spelling so both forms converge. Case
 * folding is a no-op for Indic scripts but matters for Latin.
 */
function fold(text: string): string {
  let folded = text.normalize("NFC").toLocaleLowerCase();
  // ZWJ and ZWNJ change how glyphs join, never which word it is.
  folded = folded.replace(/[\u200C\u200D]/g, "");
  for (const [pattern, replacement] of CHILLU) folded = folded.replace(pattern, replacement);
  return folded;
}

/**
 * Finds every occurrence of `query` in `runs`.
 *
 * Matching is per run, so a match never spans two runs. Both adapters emit
 * roughly one run per line, which means a search term broken across a line end
 * is missed — the same limitation a browser's find-in-page has with hyphenation.
 */
export function findMatches(runs: TextRun[], query: string): SearchMatch[] {
  const needle = fold(query).trim();
  if (needle === "") return [];

  const matches: SearchMatch[] = [];
  for (const [index, run] of runs.entries()) {
    const haystack = fold(run.text);
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      matches.push({
        run: index,
        snippet: run.text,
        at,
        rects: [{ x: run.x, y: run.y, w: run.w, h: run.h }],
      });
      // Overlapping occurrences ("aa" in "aaa") count once each, moving past
      // the start of the one just found.
      at = haystack.indexOf(needle, at + 1);
    }
  }
  return matches;
}
