import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

/**
 * Editing the text that is already on the page, rather than writing a note over
 * it. This is what "Edit PDF" means in Acrobat and what an annotation is not:
 * the words in the content stream change, so copying, searching and extracting
 * all see the new text.
 *
 * A PDF has no paragraphs. It has text objects at coordinates — one per line, or
 * per styled fragment — and nothing records which belong together. So a
 * paragraph is inferred: runs that start at the same left edge, sit about one
 * line apart, and share a font size. Every PDF editor guesses this way, and the
 * guess is wrong on tables and multi-column layouts, so the UI outlines the
 * block it detected before you type: a wrong guess is then visible rather than
 * surprising.
 *
 * Editing a block re-wraps it to the block's own width, reusing the runs that
 * are already there, adding text objects for lines that did not exist and
 * removing the ones no longer needed. Line width is measured by asking PDFium:
 * a scratch text object is given the candidate line and its bounds read back, so
 * the measurement comes from the same code that will draw it.
 *
 * Two limits remain, and the UI says so rather than hiding them:
 *
 *  * **Fonts are usually subsets.** A PDF embeds only the glyphs it used, so a
 *    character the subset lacks cannot be drawn in that font. When that happens
 *    the block is rebuilt in a standard font at the same size, position and
 *    colour, and the substitution is reported — Acrobat offers the same trade.
 *  * **A block that grows pushes nothing aside.** Extra lines are laid below the
 *    block and can overlap what follows; the result reports how many were added
 *    so the UI can warn. Acrobat behaves the same way.
 */

/** A detected paragraph: what the editor offers as one editable block. */
export interface EditableText {
  /** Page object indices making it up, in reading order. An edit addresses these. */
  indices: number[];
  text: string;
  /** Block box in PDF points, origin at the page's bottom-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  fontName: string;
  /** 0-1 RGB, so the editor can show the text in its real colour. */
  colour: [number, number, number];
}

export interface TextEdit {
  /** Source page index. */
  page: number;
  /** Indices from the `EditableText` block, valid only for the bytes it was read from. */
  indices: number[];
  text: string;
  /** Points. Omitted keeps the size the block already had. */
  fontSize?: number | undefined;
  /**
   * One of `STANDARD_FONTS`. Omitted keeps the document's own font, which is
   * usually the right answer: it may be a face no standard font resembles.
   */
  fontName?: string | undefined;
}

/**
 * The faces a block can be changed to: the PDF standard set, minus the two with
 * no letters in them. Nothing else is offered, because a font the editor has is
 * not a font the next reader has — only these are guaranteed to be drawable
 * everywhere without embedding anything.
 */
export const STANDARD_FONTS = [
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
] as const;

/** Points. Below the first, text is unreadable; above the second, absurd. */
const SIZE_RANGE = [1, 400] as const;

export interface TextEditResult {
  bytes: Uint8Array;
  /** Blocks rewritten. Fewer than asked for means some were refused. */
  applied: number;
  /**
   * Blocks whose font could not draw the new text and was replaced, with the
   * characters that forced it.
   */
  substituted: { page: number; from: string; to: string; characters: string }[];
  /** Lines added beyond what the block had, which may overlap what follows. */
  addedLines: number;
  rejected: { page: number; indices: number[]; reason: string }[];
}

const FPDF_PAGEOBJ_TEXT = 1;

/** The stand-in when the document's own font has no glyph for what was typed. */
const SUBSTITUTE = "Helvetica";

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

/** PDFium hands back UTF-16; the first call asks how many bytes it needs. */
function readUtf16(
  m: WrappedPdfiumModule,
  heap: Heap,
  read: (ptr: number, len: number) => number,
): string {
  const bytes = read(0, 0);
  if (bytes <= 2) return "";
  const ptr = heap.malloc(bytes);
  try {
    read(ptr, bytes);
    return m.pdfium.UTF16ToString(ptr);
  } finally {
    heap.free(ptr);
  }
}

/** Font names are the exception: PDFium writes those as plain UTF-8. */
function readUtf8(
  m: WrappedPdfiumModule,
  heap: Heap,
  read: (ptr: number, len: number) => number,
): string {
  const bytes = read(0, 0);
  if (bytes <= 1) return "";
  const ptr = heap.malloc(bytes);
  try {
    read(ptr, bytes);
    return m.pdfium.UTF8ToString(ptr);
  } finally {
    heap.free(ptr);
  }
}

/** FPDF_WIDESTRING is UTF-16LE with a null terminator, in wasm memory. */
function wideString(m: WrappedPdfiumModule, heap: Heap, text: string): number {
  const ptr = heap.malloc((text.length + 1) * 2);
  m.pdfium.stringToUTF16(text, ptr, (text.length + 1) * 2);
  return ptr;
}

interface Box {
  l: number;
  b: number;
  r: number;
  t: number;
}

function boundsOf(m: WrappedPdfiumModule, heap: Heap, object: number): Box | undefined {
  const ptr = heap.malloc(16);
  try {
    if (!m.FPDFPageObj_GetBounds(object, ptr, ptr + 4, ptr + 8, ptr + 12)) return undefined;
    return {
      l: m.pdfium.getValue(ptr, "float"),
      b: m.pdfium.getValue(ptr + 4, "float"),
      r: m.pdfium.getValue(ptr + 8, "float"),
      t: m.pdfium.getValue(ptr + 12, "float"),
    };
  } finally {
    heap.free(ptr);
  }
}

function fillColour(m: WrappedPdfiumModule, heap: Heap, object: number): [number, number, number] {
  const ptr = heap.malloc(16);
  try {
    if (!m.FPDFPageObj_GetFillColor(object, ptr, ptr + 4, ptr + 8, ptr + 12)) return [0, 0, 0];
    return [
      m.pdfium.getValue(ptr, "i32") / 255,
      m.pdfium.getValue(ptr + 4, "i32") / 255,
      m.pdfium.getValue(ptr + 8, "i32") / 255,
    ];
  } finally {
    heap.free(ptr);
  }
}

/** An object's transform is a b c d e f, where e and f are its origin. */
function matrixOf(m: WrappedPdfiumModule, heap: Heap, object: number): number[] {
  const ptr = heap.malloc(24);
  try {
    if (!m.FPDFPageObj_GetMatrix(object, ptr)) return [1, 0, 0, 1, 0, 0];
    return [0, 4, 8, 12, 16, 20].map((offset) => m.pdfium.getValue(ptr + offset, "float"));
  } finally {
    heap.free(ptr);
  }
}

/** Moves an object's origin, keeping whatever scale and skew it already had. */
function setOrigin(
  m: WrappedPdfiumModule,
  heap: Heap,
  object: number,
  matrix: number[],
  x: number,
  y: number,
): void {
  const ptr = heap.malloc(24);
  try {
    [matrix[0] ?? 1, matrix[1] ?? 0, matrix[2] ?? 0, matrix[3] ?? 1, x, y].forEach((value, i) =>
      m.pdfium.setValue(ptr + i * 4, value, "float"),
    );
    m.FPDFPageObj_SetMatrix(object, ptr);
  } finally {
    heap.free(ptr);
  }
}

/** One text object on the page, with everything reflow needs to replace it. */
interface Run extends Box {
  index: number;
  text: string;
  /** The text's own baseline, which is where a line is positioned from. */
  baseline: number;
  size: number;
  /** PDFium font handle, owned by the document. */
  font: number;
  fontName: string;
  colour: [number, number, number];
}

function readRuns(m: WrappedPdfiumModule, heap: Heap, doc: number, pageIndex: number): Run[] {
  const page = m.FPDF_LoadPage(doc, pageIndex);
  if (!page) throw new Error(`could not load page ${pageIndex}`);
  const textPage = m.FPDFText_LoadPage(page);

  try {
    const runs: Run[] = [];
    const scratch = heap.malloc(8);
    try {
      for (let i = 0; i < m.FPDFPage_CountObjects(page); i++) {
        const object = m.FPDFPage_GetObject(page, i);
        if (!object || m.FPDFPageObj_GetType(object) !== FPDF_PAGEOBJ_TEXT) continue;

        const text = readUtf16(m, heap, (ptr, len) =>
          m.FPDFTextObj_GetText(object, textPage, ptr, len),
        );
        if (text.trim() === "") continue;

        const box = boundsOf(m, heap, object);
        if (!box) continue;

        m.FPDFTextObj_GetFontSize(object, scratch);
        const font = m.FPDFTextObj_GetFont(object);

        runs.push({
          index: i,
          text,
          ...box,
          baseline: matrixOf(m, heap, object)[5] ?? box.b,
          size: m.pdfium.getValue(scratch, "float"),
          font,
          fontName: font
            ? readUtf8(m, heap, (ptr, len) => m.FPDFFont_GetBaseFontName(font, ptr, len))
            : "",
          colour: fillColour(m, heap, object),
        });
      }
      return runs;
    } finally {
      heap.free(scratch);
    }
  } finally {
    if (textPage) m.FPDFText_ClosePage(textPage);
    m.FPDF_ClosePage(page);
  }
}

/**
 * Groups runs into paragraphs: same left edge, same size, about one line apart.
 * Exported for its own test, because this heuristic is the part most likely to
 * be wrong on a real document.
 */
export function groupIntoBlocks<T extends Pick<Run, "l" | "t" | "baseline" | "size">>(
  runs: T[],
): T[][] {
  const ordered = [...runs].sort((a, b) => b.t - a.t || a.l - b.l);
  const blocks: T[][] = [];

  const continues = (previous: T, run: T): boolean => {
    const gap = previous.baseline - run.baseline;
    return (
      Math.abs(previous.l - run.l) <= Math.max(2, run.size * 0.6) &&
      Math.abs(previous.size - run.size) <= run.size * 0.1 &&
      // One to two lines down. More is a new block; less is a second fragment on
      // the same line, which this version leaves as its own block.
      gap > run.size * 0.6 &&
      gap < run.size * 2.4
    );
  };

  for (const run of ordered) {
    // Reading order interleaves side-by-side columns, so the block this line
    // continues is not necessarily the one most recently started: every open
    // block is a candidate, newest first.
    let open: T[] | undefined;
    for (let i = blocks.length - 1; i >= 0 && !open; i--) {
      const block = blocks[i]!;
      if (continues(block[block.length - 1]!, run)) open = block;
    }
    if (open) open.push(run);
    else blocks.push([run]);
  }
  return blocks;
}

function blockOf(block: Run[]): EditableText {
  const first = block[0]!;
  const left = Math.min(...block.map((r) => r.l));
  const right = Math.max(...block.map((r) => r.r));
  const top = Math.max(...block.map((r) => r.t));
  const bottom = Math.min(...block.map((r) => r.b));

  return {
    indices: block.map((r) => r.index),
    text: block.map((r) => r.text.trim()).join(" "),
    x: left,
    y: bottom,
    w: right - left,
    h: top - bottom,
    fontSize: first.size,
    fontName: first.fontName,
    colour: first.colour,
  };
}

/** The paragraphs on one page that can be edited in place. */
export function listEditableText(
  m: WrappedPdfiumModule,
  doc: number,
  pageIndex: number,
): EditableText[] {
  const heap = heapOf(m);
  return groupIntoBlocks(readRuns(m, heap, doc, pageIndex)).map(blockOf);
}

/**
 * Measures text in a font by handing it to PDFium and reading the bounds back.
 * Cached, because wrapping asks about the same strings repeatedly.
 */
function measurer(m: WrappedPdfiumModule, heap: Heap, doc: number, font: number, size: number) {
  const cache = new Map<string, number>();
  return (text: string): number => {
    if (text === "") return 0;
    const hit = cache.get(text);
    if (hit !== undefined) return hit;

    let width = text.length * size * 0.5; // Only if PDFium refuses to measure.
    const object = m.FPDFPageObj_CreateTextObj(doc, font, size);
    if (object) {
      const ptr = wideString(m, heap, text);
      try {
        if (m.FPDFText_SetText(object, ptr)) {
          const box = boundsOf(m, heap, object);
          if (box) width = box.r - box.l;
        }
      } finally {
        heap.free(ptr);
        // Never inserted into a page, so this object is ours to destroy.
        m.FPDFPageObj_Destroy(object);
      }
    }
    cache.set(text, width);
    return width;
  };
}

/**
 * Greedy line breaking, which is what a word processor does and is enough here.
 * Measuring the whole candidate line rather than summing words keeps kerning and
 * spacing decisions inside PDFium.
 */
export function wrap(text: string, width: number, measure: (s: string) => number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line !== "" && measure(candidate) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * Characters this font cannot draw.
 *
 * Measuring them does not answer this: a character the font has no glyph for is
 * drawn as .notdef, with the same width as any other .notdef, so a page full of
 * empty boxes would measure as perfectly fine text. Asking for the glyph's
 * outline does answer it — there is none to return.
 */
function missingGlyphs(m: WrappedPdfiumModule, font: number, size: number, text: string): string {
  const missing = new Set<string>();
  for (const character of new Set(text.replace(/\s+/g, ""))) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (!m.FPDFFont_GetGlyphPath(font, code, size)) missing.add(character);
  }
  // Enough to recognise what went wrong; a font with no letters at all would
  // otherwise fill the whole message with the alphabet.
  const listed = [...missing].slice(0, 6).join(" ");
  return missing.size > 6 ? `${listed} …` : listed;
}

/**
 * Rewrites the given paragraphs, re-wrapping each to its own width, and returns
 * the new document. `saveCopy` is passed in so this shares the writer with the
 * redaction path rather than owning a second copy of it.
 */
export function applyTextEdits(
  m: WrappedPdfiumModule,
  doc: number,
  edits: TextEdit[],
  saveCopy: () => Uint8Array,
): TextEditResult {
  const heap = heapOf(m);
  const rejected: TextEditResult["rejected"] = [];
  const substituted: TextEditResult["substituted"] = [];
  let applied = 0;
  let addedLines = 0;

  // Group by page so each page is loaded and regenerated once.
  const byPage = new Map<number, TextEdit[]>();
  for (const edit of edits) {
    byPage.set(edit.page, [...(byPage.get(edit.page) ?? []), edit]);
  }

  for (const [pageIndex, pageEdits] of byPage) {
    const runs = new Map(readRuns(m, heap, doc, pageIndex).map((run) => [run.index, run]));
    const page = m.FPDF_LoadPage(doc, pageIndex);
    if (!page) throw new Error(`could not load page ${pageIndex}`);

    try {
      let changed = false;
      // Highest index first: removing an object shifts every index after it, so
      // working downwards keeps the ones not yet edited valid.
      const ordered = [...pageEdits].sort(
        (a, b) => Math.max(...b.indices, -1) - Math.max(...a.indices, -1),
      );

      for (const edit of ordered) {
        const block = edit.indices
          .map((index) => runs.get(index))
          .filter((run): run is Run => run !== undefined);
        const first = block[0];
        if (!first) {
          rejected.push({
            page: pageIndex,
            indices: edit.indices,
            reason: "that text is no longer there; reopen the page and try again",
          });
          continue;
        }

        const left = Math.min(...block.map((run) => run.l));
        const width = Math.max(...block.map((run) => run.r)) - left;

        const size = edit.fontSize ?? first.size;
        if (!(size >= SIZE_RANGE[0] && size <= SIZE_RANGE[1])) {
          rejected.push({
            page: pageIndex,
            indices: edit.indices,
            reason: `a font size of ${size} pt is not a size anything can be read at`,
          });
          continue;
        }

        // A deliberate change of face, as opposed to the substitution below.
        // The name is checked against the standard set rather than passed
        // through: this arrives over the worker protocol.
        let font = first.font;
        if (edit.fontName !== undefined) {
          if (!(STANDARD_FONTS as readonly string[]).includes(edit.fontName)) {
            rejected.push({
              page: pageIndex,
              indices: edit.indices,
              reason: `${edit.fontName} is not one of the PDF standard fonts`,
            });
            continue;
          }
          const chosen = m.FPDFText_LoadStandardFont(doc, edit.fontName);
          if (!chosen) {
            rejected.push({
              page: pageIndex,
              indices: edit.indices,
              reason: `${edit.fontName} could not be loaded`,
            });
            continue;
          }
          font = chosen;
        }

        // Keeping the line spacing the block was set with, scaled to the new
        // size, rather than imposing a ratio of our own.
        const lineHeight =
          (block.length > 1 ? first.baseline - block[1]!.baseline : first.size * 1.2) *
          (size / first.size);

        // Can that font draw the new text? PDFs embed subsets, so this is
        // common rather than exotic.
        const missing = missingGlyphs(m, font, size, edit.text);
        if (missing !== "") {
          const standard = m.FPDFText_LoadStandardFont(doc, SUBSTITUTE);
          // Helvetica covers Latin text, which is what a subset usually lacks a
          // few glyphs of. It does not cover everything, and substituting a font
          // that cannot draw the text either would silently leave gaps on the
          // page, so that case is refused instead.
          const stillMissing = standard ? missingGlyphs(m, standard, size, edit.text) : missing;
          if (!standard || stillMissing !== "") {
            rejected.push({
              page: pageIndex,
              indices: edit.indices,
              reason:
                `${first.fontName || "that font"} cannot show ${missing}, and nor ` +
                `can ${SUBSTITUTE}: that character needs a font neither this ` +
                "document nor the PDF standard set provides",
            });
            continue;
          }
          font = standard;
          substituted.push({
            page: pageIndex,
            from: first.fontName || "the document's font",
            to: SUBSTITUTE,
            characters: missing,
          });
        }

        // A run carries its own font and size, and neither can be changed in
        // place, so any change of face or size rebuilds the block the same way a
        // substitution does.
        const rebuilding = font !== first.font || size !== first.size;
        const lines = wrap(edit.text, width, measurer(m, heap, doc, font, size));

        for (const [line, text] of lines.entries()) {
          const y = first.baseline - line * lineHeight;
          const reuse = rebuilding ? undefined : block[line];
          const object = reuse
            ? m.FPDFPage_GetObject(page, reuse.index)
            : m.FPDFPageObj_CreateTextObj(doc, font, size);
          if (!object) continue;

          const ptr = wideString(m, heap, text);
          try {
            if (!m.FPDFText_SetText(object, ptr)) {
              if (!reuse) m.FPDFPageObj_Destroy(object);
              rejected.push({
                page: pageIndex,
                indices: edit.indices,
                reason: "PDFium refused the new text",
              });
              continue;
            }
          } finally {
            heap.free(ptr);
          }

          if (reuse) {
            setOrigin(m, heap, object, matrixOf(m, heap, object), left, y);
          } else {
            const [r, g, b] = first.colour;
            m.FPDFPageObj_SetFillColor(
              object,
              Math.round(r * 255),
              Math.round(g * 255),
              Math.round(b * 255),
              255,
            );
            setOrigin(m, heap, object, [1, 0, 0, 1, 0, 0], left, y);
            // Appends, so existing object indices keep their meaning.
            m.FPDFPage_InsertObject(page, object);
          }
        }

        // Runs the new text no longer needs — all of them when the font was
        // replaced. Highest index first, again because removal shifts indices.
        const surplus = rebuilding ? block : block.slice(lines.length);
        for (const run of [...surplus].sort((a, b) => b.index - a.index)) {
          const object = m.FPDFPage_GetObject(page, run.index);
          if (object && m.FPDFPage_RemoveObject(page, object)) m.FPDFPageObj_Destroy(object);
        }

        // Lines the block did not have before, which sit below it and may
        // overlap whatever follows.
        addedLines += Math.max(0, lines.length - block.length);
        applied++;
        changed = true;
      }

      if (changed && !m.FPDFPage_GenerateContent(page)) {
        throw new Error(`could not rewrite page ${pageIndex} after editing`);
      }
    } finally {
      m.FPDF_ClosePage(page);
    }
  }

  return { bytes: saveCopy(), applied, substituted, addedLines, rejected };
}
