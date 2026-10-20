import { PDFDocument } from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * The document's own description — Acrobat's File ▸ Properties.
 *
 * It is what a library catalogue, a search index and a file browser read, and
 * what most documents carry wrong: "Microsoft Word - final(2).docx" as the
 * title, the name of whoever owned the laptop as the author. Worth being able
 * to fix before a document is published.
 */
export interface DocumentProperties {
  title: string;
  author: string;
  subject: string;
  /** Free text, as Acrobat shows it; stored as the PDF's keyword list. */
  keywords: string;
  /** Read-only, for display: what made the file. */
  creator?: string;
  producer?: string;
}

export async function readProperties(input: PdfBytes): Promise<DocumentProperties> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  return {
    title: doc.getTitle() ?? "",
    author: doc.getAuthor() ?? "",
    subject: doc.getSubject() ?? "",
    keywords: doc.getKeywords() ?? "",
    creator: doc.getCreator() ?? "",
    producer: doc.getProducer() ?? "",
  };
}

/**
 * Writes the description back. Fields given as empty strings are cleared, since
 * "remove the previous owner's name" is the whole point of editing these.
 *
 * Loading with `updateMetadata: false` is what keeps pdf-lib from stamping
 * itself as the producer before we have written anything.
 */
export async function setProperties(
  input: PdfBytes,
  properties: Partial<DocumentProperties>,
): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  if (properties.title !== undefined) doc.setTitle(properties.title);
  if (properties.author !== undefined) doc.setAuthor(properties.author);
  if (properties.subject !== undefined) doc.setSubject(properties.subject);
  if (properties.keywords !== undefined) {
    // pdf-lib takes a list and joins it; Acrobat shows one line, so one entry
    // keeps what the user typed exactly as they typed it.
    doc.setKeywords([properties.keywords]);
  }
  doc.setModificationDate(new Date());
  return doc.save();
}
