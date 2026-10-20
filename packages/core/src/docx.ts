import { zip } from "./zip.js";

/**
 * PDF to Word, for the half of the job that can be done honestly.
 *
 * What this produces is the document's **words**, in reading order, one
 * paragraph per line and a page break between pages. What it does not produce
 * is the layout: no columns, no tables as tables, no images, no fonts, no
 * positioning. A PDF does not record any of those as structure — it records
 * where ink goes — and reconstructing them is guesswork that Acrobat does
 * moderately well with twenty years of heuristics and that nobody does
 * perfectly.
 *
 * The export is therefore labelled for what it is. Someone who needs the text
 * of a circular to paste into a reply is served; someone who expects their
 * layout back is told, up front, that this is not that.
 */

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

function paragraph(text: string, bold = false): string {
  if (text.trim() === "") return `<w:p/>`;
  return (
    `<w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}` +
    `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  );
}

/** A page break, which is how the pages of the PDF survive into the document. */
const PAGE_BREAK = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;

/** Builds a .docx from the text of each page. */
export function toDocx(pages: string[], options: DocxOptions = {}): Uint8Array {
  const body: string[] = [];
  if (options.title) body.push(paragraph(options.title, true));

  pages.forEach((page, index) => {
    if (index > 0) body.push(PAGE_BREAK);
    const lines = page.split(/\r?\n/);
    for (const line of lines) body.push(paragraph(line));
  });

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join("")}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>` +
    `</w:body></w:document>`;

  const encoder = new TextEncoder();
  return zip([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: encoder.encode(RELS) },
    { name: "word/document.xml", data: encoder.encode(document) },
  ]);
}
