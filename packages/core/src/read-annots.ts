import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * Reading the marks a document already carries.
 *
 * Until now the Marks panel listed only what this session had placed, so
 * opening a document someone else had commented on showed nothing — the marks
 * were on the page, and the list said "no marks yet". A reviewer's first
 * question about a returned document is "what did they say", and this answers
 * it.
 *
 * These are read, not owned: they are already in the file, so they are not
 * rewritten on save. Removing one is its own operation.
 */

export interface ExistingAnnotation {
  /** Source page index. */
  page: number;
  /** Index among that page's `/Annots`, which is how one is addressed. */
  index: number;
  /** The PDF subtype, lower-cased: highlight, text, square, stamp, link. */
  kind: string;
  /** What it says, where it says anything. */
  contents: string;
  author: string;
  /** Box in PDF points, origin at the page's bottom-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0-1 RGB where the annotation records one. */
  colour?: [number, number, number] | undefined;
  /** Acrobat's review state, where one was set. */
  state?: string | undefined;
  /**
   * Index of the mark this one answers, where it answers one. A reply and a
   * status are both annotations pointing at their parent with `/IRT`; `/RT`
   * says which it is.
   */
  inReplyTo?: number | undefined;
  /** "R" for a reply, "Group" for a status set on the parent. */
  replyType?: string | undefined;
  /** When it was written, as the file records it. */
  date?: string | undefined;
}

/** Every mark already in the document, in page order. */
export async function readAnnotations(input: PdfBytes): Promise<ExistingAnnotation[]> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const out: ExistingAnnotation[] = [];

  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots();
    const refs = annots?.asArray() ?? [];
    /** Which position in this page's list a reference points at. */
    const positionOf = (target: unknown) => refs.findIndex((ref) => String(ref) === String(target));

    refs.forEach((ref, index) => {
      const annot = doc.context.lookup(ref);
      if (!(annot instanceof PDFDict)) return;

      const subtype = annot.get(PDFName.of("Subtype"));
      const kind =
        subtype instanceof PDFName ? subtype.asString().replace(/^\//, "").toLowerCase() : "";
      // Form fields are not marks; they have their own panel.
      if (kind === "" || kind === "widget" || kind === "popup") return;

      const rect = annot.lookup(PDFName.of("Rect"));
      const numbers =
        rect instanceof PDFArray
          ? rect.asArray().map((value) => (value instanceof PDFNumber ? value.asNumber() : 0))
          : [0, 0, 0, 0];
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = numbers;

      out.push({
        page: pageIndex,
        index,
        kind,
        contents: textOf(annot, "Contents"),
        author: textOf(annot, "T"),
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1),
        ...(colourOf(annot) ? { colour: colourOf(annot) } : {}),
        ...(textOf(annot, "State") ? { state: textOf(annot, "State") } : {}),
        ...(textOf(annot, "M") ? { date: textOf(annot, "M") } : {}),
        ...(annot.get(PDFName.of("IRT")) !== undefined
          ? { inReplyTo: positionOf(annot.get(PDFName.of("IRT"))) }
          : {}),
        ...(annot.get(PDFName.of("RT")) !== undefined
          ? {
              replyType: String(annot.get(PDFName.of("RT"))).replace(/^\//, ""),
            }
          : {}),
      });
    });
  });

  return out;
}

/** Removes one mark from a page, by the index `readAnnotations` reported. */
export async function deleteAnnotation(
  input: PdfBytes,
  page: number,
  index: number,
): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const count = doc.getPageCount();
  if (!Number.isInteger(page) || page < 0 || page >= count) {
    throw new RangeError(`page ${page} outside a ${count}-page document`);
  }
  const node = doc.getPage(page).node;
  const annots = node.Annots();
  const list = annots?.asArray() ?? [];
  if (index < 0 || index >= list.length) {
    throw new RangeError(`no mark ${index} on page ${page + 1}`);
  }
  node.set(PDFName.of("Annots"), doc.context.obj(list.filter((_, at) => at !== index)));
  return doc.save();
}

function textOf(annot: PDFDict, key: string): string {
  const value = annot.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : "";
}

function colourOf(annot: PDFDict): [number, number, number] | undefined {
  const colour = annot.lookup(PDFName.of("C"));
  if (!(colour instanceof PDFArray)) return undefined;
  const parts = colour
    .asArray()
    .map((value) => (value instanceof PDFNumber ? value.asNumber() : 0));
  // PDF allows grey, RGB and CMYK here; the first two are what marks use.
  if (parts.length === 1) return [parts[0]!, parts[0]!, parts[0]!];
  if (parts.length >= 3) return [parts[0]!, parts[1]!, parts[2]!];
  return undefined;
}

/** A reply to a mark, or a review state set on it. */
export interface Reply {
  /** Source page index of the mark being answered. */
  page: number;
  /** Its index among that page's `/Annots`. */
  index: number;
  contents: string;
  author?: string | undefined;
  /**
   * Set to mark the parent accepted, rejected, cancelled or completed, as
   * Acrobat's comment pane does. A status is a reply with no words of its own,
   * which is how the format carries one.
   */
  state?: "Accepted" | "Rejected" | "Cancelled" | "Completed" | "None" | undefined;
}

/**
 * Answers a mark, or sets its review state.
 *
 * Both are annotations of their own pointing at the parent with `/IRT` — the
 * format has no field on a comment for "resolved", so a status is a reply
 * carrying `/State` instead. That is what Acrobat writes and what Acrobat
 * reads, which is the only reason to do it this way rather than something
 * tidier.
 */
export async function addReply(input: PdfBytes, reply: Reply): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const count = doc.getPageCount();
  if (!Number.isInteger(reply.page) || reply.page < 0 || reply.page >= count) {
    throw new RangeError(`page ${reply.page} outside a ${count}-page document`);
  }
  const node = doc.getPage(reply.page).node;
  const refs = node.Annots()?.asArray() ?? [];
  const parent = refs[reply.index];
  if (!parent) throw new RangeError(`no mark ${reply.index} on page ${reply.page + 1}`);

  const parentDict = doc.context.lookup(parent);
  const rect = parentDict instanceof PDFDict ? parentDict.lookup(PDFName.of("Rect")) : undefined;

  const stamp = pdfDate(new Date());
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Text",
    // Sits on the parent, because a reply has no place of its own.
    Rect: rect instanceof PDFArray ? rect.asArray() : [0, 0, 24, 24],
    Contents: PDFString.of(reply.contents),
    T: PDFString.of(reply.author ?? "PDF Suite"),
    M: PDFString.of(stamp),
    CreationDate: PDFString.of(stamp),
    IRT: parent,
    // A plain reply groups with its parent; a state is a Group reply carrying
    // the state, which is the distinction /RT exists to make.
    RT: PDFName.of(reply.state ? "Group" : "R"),
    ...(reply.state
      ? { State: PDFString.of(reply.state), StateModel: PDFString.of("Review") }
      : {}),
    F: 4,
    Open: false,
  });

  node.set(PDFName.of("Annots"), doc.context.obj([...refs, doc.context.register(annot)]));
  return doc.save();
}

/** PDF date format, e.g. D:20261020120000Z. */
function pdfDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `D:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}
