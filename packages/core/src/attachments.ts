import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";
import { place } from "./stamp.js";
import type { PdfBytes } from "./ops.js";

/**
 * Files carried inside a PDF — Acrobat's attachments panel.
 *
 * A circular that travels with its annexure, a form that travels with the
 * spreadsheet it was built from. The file is embedded, so it goes where the PDF
 * goes and never over a network.
 *
 * Note the other side of that: `sanitise` removes attachments, because a file
 * nobody remembers attaching is exactly what leaks. Both behaviours are
 * deliberate and the UI names them.
 */

export interface Attachment {
  name: string;
  /** Bytes, which is what the panel shows as a size. */
  size: number;
  description?: string | undefined;
}

/** Embeds a file. A name already attached is replaced, as Acrobat does. */
export async function attachFile(
  input: PdfBytes,
  file: {
    name: string;
    bytes: Uint8Array;
    description?: string | undefined;
    type?: string | undefined;
  },
): Promise<PdfBytes> {
  if (file.name.trim() === "") throw new Error("an attachment needs a name");
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  await doc.attach(file.bytes, file.name, {
    ...(file.description ? { description: file.description } : {}),
    ...(file.type ? { mimeType: file.type } : {}),
  });
  return doc.save();
}

/** Every file carried inside the document. */
export async function listAttachments(input: PdfBytes): Promise<Attachment[]> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  return entriesOf(doc).map(([name, spec]) => {
    const stream = embeddedStream(doc, spec);
    const params = stream?.dict.lookup(PDFName.of("Params"));
    const size =
      params instanceof PDFDict
        ? Number(params.lookup(PDFName.of("Size"))?.toString() ?? 0)
        : stream
          ? decodePDFRawStream(stream).decode().length
          : 0;
    const description = spec.lookup(PDFName.of("Desc"));
    return {
      name,
      size,
      ...(description instanceof PDFString || description instanceof PDFHexString
        ? { description: description.decodeText() }
        : {}),
    };
  });
}

/** The bytes of one attached file. */
export async function readAttachment(input: PdfBytes, name: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const entry = entriesOf(doc).find(([attached]) => attached === name);
  if (!entry) throw new Error(`no file called ${name} is attached`);
  const stream = embeddedStream(doc, entry[1]);
  if (!stream) throw new Error(`${name} is attached but carries no content`);
  return decodePDFRawStream(stream).decode();
}

/** Removes one attached file, leaving the rest. */
export async function removeAttachment(input: PdfBytes, name: string): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const names = embeddedFilesNode(doc);
  if (!names) throw new Error(`no file called ${name} is attached`);
  const list = names.lookup(PDFName.of("Names"), PDFArray);

  const kept: unknown[] = [];
  let found = false;
  for (let i = 0; i < list.size(); i += 2) {
    const key = list.lookup(i);
    const title =
      key instanceof PDFString || key instanceof PDFHexString ? key.decodeText() : String(key);
    if (title === name) {
      found = true;
      continue;
    }
    kept.push(list.get(i), list.get(i + 1));
  }
  if (!found) throw new Error(`no file called ${name} is attached`);
  names.set(PDFName.of("Names"), doc.context.obj(kept as never));
  return doc.save();
}

/** The /EmbeddedFiles name tree, if the document has one. */
function embeddedFilesNode(doc: PDFDocument): PDFDict | undefined {
  const names = doc.catalog.lookup(PDFName.of("Names"));
  if (!(names instanceof PDFDict)) return undefined;
  const embedded = names.lookup(PDFName.of("EmbeddedFiles"));
  return embedded instanceof PDFDict ? embedded : undefined;
}

/** Name and file-specification pairs, flattened out of the name tree. */
function entriesOf(doc: PDFDocument): [string, PDFDict][] {
  const node = embeddedFilesNode(doc);
  if (!node) return [];
  const list = node.lookup(PDFName.of("Names"));
  if (!(list instanceof PDFArray)) return [];

  const out: [string, PDFDict][] = [];
  for (let i = 0; i < list.size(); i += 2) {
    const key = list.lookup(i);
    const spec = list.lookup(i + 1);
    if (!(spec instanceof PDFDict)) continue;
    const name =
      key instanceof PDFString || key instanceof PDFHexString ? key.decodeText() : String(key);
    out.push([name, spec]);
  }
  return out;
}

/** The stream behind a file specification: /EF /F. */
function embeddedStream(doc: PDFDocument, spec: PDFDict): PDFRawStream | undefined {
  const ef = spec.lookup(PDFName.of("EF"));
  if (!(ef instanceof PDFDict)) return undefined;
  const file = ef.lookup(PDFName.of("F"));
  return file instanceof PDFRawStream ? file : undefined;
}

/** A file attached at a point on a page — Acrobat's paperclip comment. */
export interface AttachmentNote {
  /** Page index in the file's own order. */
  page: number;
  /** Where the icon goes, in the coordinates the reader sees. */
  x: number;
  y: number;
  name: string;
  bytes: Uint8Array;
  /** The comment that travels with the file. */
  note?: string | undefined;
  author?: string | undefined;
  type?: string | undefined;
}

/** The icon's side, in points. Acrobat's is about this size. */
const ICON = 20;

/**
 * Attaches a file *at a point on a page*, rather than only to the document.
 *
 * The difference matters to a reader: a document attachment lives in a panel
 * nobody opens, while this one is a mark on the page next to the paragraph it
 * belongs to — the annexure beside the clause that refers to it.
 *
 * The icon is drawn into an appearance stream rather than left to `/Name`,
 * because a viewer that synthesises nothing (ours included) would otherwise
 * show an attachment that is invisible on the page.
 */
export async function attachToPage(input: PdfBytes, note: AttachmentNote): Promise<PdfBytes> {
  if (note.name.trim() === "") throw new Error("an attachment needs a name");
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  if (!Number.isInteger(note.page) || note.page < 0 || note.page >= doc.getPageCount()) {
    throw new RangeError(`page ${note.page} outside a ${doc.getPageCount()}-page document`);
  }

  await doc.attach(note.bytes, note.name, {
    ...(note.note ? { description: note.note } : {}),
    ...(note.type ? { mimeType: note.type } : {}),
  });
  // pdf-lib embeds attachments when the document is written. Flushing now puts
  // the file specification in the name tree, which is what the annotation has
  // to point at — the same file, not a second copy of it.
  await doc.flush();

  const spec = entriesOf(doc).find(([name]) => name === note.name);
  if (!spec) throw new Error(`could not attach ${note.name}`);
  const specRef = doc.context.getObjectRef(spec[1]);
  if (!specRef) throw new Error(`could not attach ${note.name}`);

  const page = doc.getPage(note.page);
  const { width, height } = page.getSize();
  const rotation = page.getRotation().angle;
  const a = place(width, height, rotation, note.x, note.y);
  const b = place(width, height, rotation, note.x + ICON, note.y + ICON);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);

  // A sheet of paper with its corner turned down. /BBox in page coordinates
  // matching /Rect makes the form's mapping the identity, so what is drawn
  // here lands where the rectangle says.
  const appearance = doc.context.flateStream(
    `q 1 0.82 0.25 rg 0.25 0.22 0.18 RG 1 w ` +
      `${x + 3} ${y + 1} m ${x + 3} ${y + 19} l ${x + 11} ${y + 19} l ` +
      `${x + 17} ${y + 13} l ${x + 17} ${y + 1} l h B ` +
      `${x + 11} ${y + 19} m ${x + 11} ${y + 13} l ${x + 17} ${y + 13} l S Q\n`,
    {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: [x, y, x + ICON, y + ICON],
      Resources: {},
    },
  );

  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "FileAttachment",
    Rect: [x, y, x + ICON, y + ICON],
    FS: specRef,
    Name: "Paperclip",
    // Printed, and not scaled with zoom — an icon the size of a word.
    F: 4,
    AP: { N: doc.context.register(appearance) },
    ...(note.note ? { Contents: PDFHexString.fromText(note.note) } : {}),
    ...(note.author ? { T: PDFHexString.fromText(note.author) } : {}),
    M: PDFString.fromDate(new Date()),
  });

  const annots = page.node.lookup(PDFName.of("Annots"));
  if (annots instanceof PDFArray) annots.push(doc.context.register(annot));
  else page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(annot)]));

  return doc.save();
}
