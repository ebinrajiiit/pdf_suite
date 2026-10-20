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
