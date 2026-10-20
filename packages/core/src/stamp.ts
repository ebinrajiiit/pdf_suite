import { degrees, PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Headers, footers, page numbers and Bates numbering — Acrobat's "Add Header &
 * Footer" and "Bates Numbering", which are the same machine with different
 * dials: text in six slots, with a page number token in whichever of them you
 * want it.
 *
 * The text is drawn into the page content, not written as an annotation, so it
 * prints, extracts and survives flattening the way Acrobat's does.
 */

/** Left, centre, right. Empty strings are skipped. */
export type Slots = [string, string, string];

export type NumberFormat = "1" | "i" | "I" | "a" | "A";

export interface StampOptions {
  header?: Slots | undefined;
  footer?: Slots | undefined;
  /** Points. Acrobat's default is 10. */
  fontSize?: number | undefined;
  /** Distance from the page edge, in points. Acrobat's default is half an inch. */
  margin?: number | undefined;
  /** The number given to the first stamped page. */
  startAt?: number | undefined;
  /**
   * Zero-pads the page number to this many digits, which is the whole of what
   * Bates numbering adds: a prefix and suffix are just text in the same slot.
   */
  digits?: number | undefined;
  format?: NumberFormat | undefined;
  /** Page indices to stamp, in document order. Default: every page. */
  pages?: number[] | undefined;
  /** What `{file}` becomes. */
  name?: string | undefined;
  /** What `{date}` becomes. Injectable so a test is not at the mercy of today. */
  date?: Date | undefined;
}

/** What a slot can contain besides literal text. */
const TOKENS = ["{n}", "{total}", "{date}", "{file}"] as const;

export function roman(value: number): string {
  const table: [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let left = Math.max(0, Math.trunc(value));
  let out = "";
  for (const [size, numeral] of table) {
    while (left >= size) {
      out += numeral;
      left -= size;
    }
  }
  return out;
}

/** a, b, … z, aa, ab — the spreadsheet column scheme Acrobat uses. */
export function letters(value: number): string {
  let left = Math.max(1, Math.trunc(value));
  let out = "";
  while (left > 0) {
    const digit = (left - 1) % 26;
    out = String.fromCharCode(97 + digit) + out;
    left = Math.floor((left - 1) / 26);
  }
  return out;
}

export function formatNumber(value: number, format: NumberFormat, digits = 0): string {
  const plain =
    format === "i"
      ? roman(value)
      : format === "I"
        ? roman(value).toUpperCase()
        : format === "a"
          ? letters(value)
          : format === "A"
            ? letters(value).toUpperCase()
            : String(value);
  return digits > 0 ? plain.padStart(digits, "0") : plain;
}

/**
 * Where a point on the page as the reader sees it lands in the page's own
 * coordinates, and at what angle text must be drawn to look upright.
 *
 * A page can carry a /Rotate, and ours often does — rotating pages is a feature
 * of this app. Without this the footer of a rotated page would be stamped along
 * what the reader sees as a side edge, upside down.
 */
export function place(
  width: number,
  height: number,
  rotation: number,
  visualX: number,
  visualY: number,
): { x: number; y: number; angle: number } {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return { x: width - visualY, y: visualX, angle: 90 };
    case 180:
      return { x: width - visualX, y: height - visualY, angle: 180 };
    case 270:
      return { x: visualY, y: height - visualX, angle: 270 };
    default:
      return { x: visualX, y: visualY, angle: 0 };
  }
}

/** The page as the reader sees it: a quarter turn swaps the sides. */
function visualSize(width: number, height: number, rotation: number) {
  const turned = ((rotation % 360) + 360) % 360;
  return turned === 90 || turned === 270 ? { width: height, height: width } : { width, height };
}

/**
 * Standard fonts are WinAnsi, so they cannot draw Malayalam or an em dash typed
 * by a word processor. Rather than letting pdf-lib throw halfway through a
 * document, the text is checked first and the caller told which characters are
 * the problem (English-first, docs/ROADMAP.md — an embedded Unicode font is what
 * this waits on).
 */
export function unsupported(text: string, font: PDFFont): string[] {
  const bad = new Set<string>();
  for (const character of text) {
    try {
      font.widthOfTextAtSize(character, 12);
    } catch {
      bad.add(character);
    }
  }
  return [...bad];
}

function fill(slot: string, values: Record<(typeof TOKENS)[number], string>): string {
  return TOKENS.reduce((text, token) => text.split(token).join(values[token]), slot);
}

export async function stampPages(input: Uint8Array, options: StampOptions): Promise<Uint8Array> {
  const header = options.header ?? ["", "", ""];
  const footer = options.footer ?? ["", "", ""];
  if (![...header, ...footer].some((slot) => slot.trim() !== "")) {
    throw new Error("nothing to stamp: every header and footer slot is empty");
  }

  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = options.fontSize ?? 10;
  const margin = options.margin ?? 36;
  const format = options.format ?? "1";
  const pages = options.pages ?? doc.getPageIndices();
  const date = options.date ?? new Date();

  const count = doc.getPageCount();
  for (const index of pages) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError(`page ${index} outside a ${count}-page document`);
    }
  }

  const values = (position: number): Record<(typeof TOKENS)[number], string> => ({
    "{n}": formatNumber((options.startAt ?? 1) + position, format, options.digits ?? 0),
    "{total}": formatNumber(pages.length, format),
    "{date}": date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
    "{file}": options.name ?? "",
  });

  // Every slot of every page is resolved before anything is drawn, so a
  // character the font cannot draw stops the whole operation rather than
  // leaving half a document stamped.
  const resolved = pages.map((index, position) => ({
    page: doc.getPage(index),
    header: header.map((slot) => fill(slot, values(position))) as Slots,
    footer: footer.map((slot) => fill(slot, values(position))) as Slots,
  }));

  const bad = new Set<string>();
  for (const { header: top, footer: bottom } of resolved) {
    for (const text of [...top, ...bottom]) {
      for (const character of unsupported(text, font)) bad.add(character);
    }
  }
  if (bad.size > 0) {
    throw new Error(
      `Helvetica cannot draw ${[...bad].join(" ")}. Headers and footers are ` +
        "limited to the characters the PDF standard fonts have, which is Latin " +
        "text and common punctuation.",
    );
  }

  for (const { page, header: top, footer: bottom } of resolved) {
    draw(page, font, size, margin, top, "header");
    draw(page, font, size, margin, bottom, "footer");
  }

  return doc.save();
}

function draw(
  page: PDFPage,
  font: PDFFont,
  size: number,
  margin: number,
  slots: Slots,
  where: "header" | "footer",
): void {
  const { width, height } = page.getSize();
  const rotation = page.getRotation().angle;
  const visual = visualSize(width, height, rotation);
  // The baseline sits inside the margin: a descender should not touch the edge.
  const y = where === "header" ? visual.height - margin : margin - size * 0.25;

  slots.forEach((text, slot) => {
    if (text.trim() === "") return;
    const textWidth = font.widthOfTextAtSize(text, size);
    const x =
      slot === 0
        ? margin
        : slot === 1
          ? (visual.width - textWidth) / 2
          : visual.width - margin - textWidth;

    const at = place(width, height, rotation, x, y);
    page.drawText(text, { x: at.x, y: at.y, size, font, rotate: degrees(at.angle) });
  });
}
