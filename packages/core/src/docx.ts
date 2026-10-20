import { zip } from "./zip.js";

/**
 * PDF to Word, for the part of the job that can be done honestly.
 *
 * What this produces is the document's **text, as paragraphs**: each paragraph
 * one paragraph, at roughly its own size, with a page break between pages and
 * a table where the page really is a table. What it does not reproduce is the
 * layout — no columns, no images, no positioning, no styles — because a PDF
 * does not record those as structure. It records where ink goes, and
 * reconstructing the rest is guesswork that Acrobat does moderately well with
 * twenty years of heuristics and that nobody does perfectly.
 *
 * The important thing it does not do is break every line into its own
 * paragraph. That is what a naive export does — one `<w:p>` per extracted line
 * — and the result cannot be edited: every line ends in a hard paragraph mark,
 * so adding a word pushes nothing along and reflows nothing. Paragraphs come
 * from the engine's own block detection instead, the same one in-place editing
 * uses.
 */

export type DocxBlock =
  | {
      kind: "paragraph";
      text: string;
      /** Points, as the PDF had it. Word is told half-points. */
      size?: number | undefined;
      bold?: boolean | undefined;
    }
  /** Rows of cells, each row the same length. */
  | { kind: "table"; rows: string[][] };

export interface DocxPage {
  blocks: DocxBlock[];
  /** The page's size in PDF points, so a landscape PDF lands in a landscape document. */
  width?: number | undefined;
  height?: number | undefined;
}

export interface DocxOptions {
  title?: string | undefined;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** The document part has no relationships of its own, but Word expects the part to exist. */
const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

function escapeXml(text: string): string {
  return (
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      // Control characters are not allowed in XML at all, and extracted text
      // sometimes carries them. The rule against control characters in a
      // regular expression is exactly backwards here: finding them is the job.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  );
}

/** Word measures text in half-points and nothing smaller than 1pt is text. */
function halfPoints(size: number | undefined): number | undefined {
  if (size === undefined || !Number.isFinite(size) || size < 1) return undefined;
  return Math.round(Math.min(size, 400) * 2);
}

function runProperties(block: { size?: number | undefined; bold?: boolean | undefined }): string {
  const size = halfPoints(block.size);
  if (!block.bold && size === undefined) return "";
  return (
    `<w:rPr>${block.bold ? "<w:b/>" : ""}` +
    (size === undefined ? "" : `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`) +
    `</w:rPr>`
  );
}

function paragraph(
  text: string,
  options: { size?: number | undefined; bold?: boolean | undefined } = {},
): string {
  if (text.trim() === "") return `<w:p/>`;
  const properties = runProperties(options);
  return (
    `<w:p><w:r>${properties}` + `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  );
}

/** Twips — twentieths of a point — which is what Word measures pages in. */
function twips(points: number): number {
  return Math.round(points * 20);
}

/**
 * A table, with borders, sized by Word rather than by us: the column widths a
 * PDF implies are where the text happens to start, which is not the same thing
 * as how wide the column is.
 */
function table(rows: string[][]): string {
  const columns = Math.max(...rows.map((row) => row.length), 1);
  const border = `<w:top w:val="single" w:sz="4" w:color="auto"/>
<w:left w:val="single" w:sz="4" w:color="auto"/>
<w:bottom w:val="single" w:sz="4" w:color="auto"/>
<w:right w:val="single" w:sz="4" w:color="auto"/>
<w:insideH w:val="single" w:sz="4" w:color="auto"/>
<w:insideV w:val="single" w:sz="4" w:color="auto"/>`.replace(/\n/g, "");

  const body = rows
    .map(
      (row) =>
        `<w:tr>` +
        Array.from({ length: columns }, (_, column) => {
          const cell = row[column] ?? "";
          return (
            `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>` +
            `<w:p><w:r><w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`
          );
        }).join("") +
        `</w:tr>`,
    )
    .join("");

  return (
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>` +
    `<w:tblGrid>${`<w:gridCol w:w="0"/>`.repeat(columns)}</w:tblGrid>` +
    `${body}</w:tbl>` +
    // A table at the end of a cell or body has to be followed by a paragraph,
    // or Word treats the file as corrupt.
    `<w:p/>`
  );
}

/**
 * Splits a detected grid into the table itself and the lines around it.
 *
 * A page with a table on it is rarely only a table: there is a heading above
 * it and often a note below. The detector sees those as rows with one cell
 * filled, and a heading sitting in the first cell of a table is the kind of
 * thing someone then has to undo by hand. A row that fills fewer than two
 * columns is therefore a paragraph, and the rows between them are the table.
 *
 * `styleOf` gives back the size and weight the text had in the PDF, where it is
 * known — the heading above a table is usually larger than the table.
 */
export function blocksFromGrid(
  rows: string[][],
  styleOf?: (text: string) => { size?: number | undefined; bold?: boolean | undefined } | undefined,
): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  let run: string[][] = [];

  const line = (row: string[]): void => {
    const text = row
      .filter((cell) => cell.trim() !== "")
      .join(" ")
      .trim();
    if (text !== "") blocks.push({ kind: "paragraph", text, ...(styleOf?.(text) ?? {}) });
  };

  const flush = (): void => {
    // One row is not a table, whatever its shape; it is a line with a gap in it.
    if (run.length >= 2) blocks.push({ kind: "table", rows: run });
    else for (const row of run) line(row);
    run = [];
  };

  for (const row of rows) {
    if (row.filter((cell) => cell.trim() !== "").length >= 2) run.push(row);
    else {
      flush();
      line(row);
    }
  }
  flush();
  return blocks;
}

/** A4 portrait, for a document that does not say what size its pages are. */
const A4 = { width: 595, height: 842 };

/** The page setup for a run of pages that are all the same size. */
function sectionProperties(width: number, height: number): string {
  return (
    `<w:sectPr><w:pgSz w:w="${twips(width)}" w:h="${twips(height)}"` +
    `${width > height ? ' w:orient="landscape"' : ""}/>` +
    `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>`
  );
}

/** Builds a .docx from each page's blocks. */
export function toDocx(pages: DocxPage[], options: DocxOptions = {}): Uint8Array {
  const body: string[] = [];
  if (options.title) body.push(paragraph(options.title, { bold: true }));

  // Pages of the same size are one section. A letter with a landscape annexure
  // is two, because a section is the only thing in Word that carries a page
  // size — one section for the document would turn the annexure portrait.
  const sections: { pages: DocxPage[]; width: number; height: number }[] = [];
  for (const page of pages) {
    const width = page.width ?? A4.width;
    const height = page.height ?? A4.height;
    const last = sections[sections.length - 1];
    if (last && last.width === width && last.height === height) last.pages.push(page);
    else sections.push({ pages: [page], width, height });
  }

  sections.forEach((section, sectionIndex) => {
    section.pages.forEach((page, index) => {
      // Within a section, a page break. Between sections the section break is
      // the page break, so there is no second one.
      if (index > 0) body.push(PAGE_BREAK);
      for (const block of page.blocks) {
        if (block.kind === "table") body.push(table(block.rows));
        else body.push(paragraph(block.text, block));
      }
    });
    // Every section but the last carries its page setup on a paragraph of its
    // own; the last one's goes at the end of the body, which is where Word
    // looks for the final section.
    if (sectionIndex < sections.length - 1) {
      body.push(`<w:p><w:pPr>${sectionProperties(section.width, section.height)}</w:pPr></w:p>`);
    }
  });

  const last = sections[sections.length - 1];
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join("")}` +
    sectionProperties(last?.width ?? A4.width, last?.height ?? A4.height) +
    `</w:body></w:document>`;

  const encoder = new TextEncoder();
  return zip([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: encoder.encode(RELS) },
    { name: "word/_rels/document.xml.rels", data: encoder.encode(DOCUMENT_RELS) },
    { name: "word/document.xml", data: encoder.encode(document) },
  ]);
}

/** A page break, which is how the pages of the PDF survive into the document. */
const PAGE_BREAK = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
