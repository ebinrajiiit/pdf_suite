import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * Removing what a document carries but does not show — Acrobat's "Remove hidden
 * information" and "Sanitize document".
 *
 * This is the other half of redaction, and the half people forget. A file whose
 * Aadhaar numbers have been removed from the page still names the clerk who
 * typed it in its metadata, may carry the original spreadsheet as an
 * attachment, and may run a script when it opens. None of that is visible on
 * any page, and all of it travels with the file.
 *
 * What is removed is listed rather than assumed: the report says what was
 * found, so a document that had nothing hidden can be told apart from one this
 * failed to clean.
 */

export interface SanitiseOptions {
  /** Title, author, producer, dates, and the XMP packet. */
  metadata?: boolean;
  /** Files carried inside the document. */
  attachments?: boolean;
  /** Document-level JavaScript and actions that run on open or on a page. */
  scripts?: boolean;
  /** Every annotation: notes, highlights, stamps, drawings. */
  comments?: boolean;
  /** Link annotations and the actions behind them. */
  links?: boolean;
}

export interface SanitiseReport {
  metadata: boolean;
  attachments: number;
  scripts: number;
  comments: number;
  links: number;
}

export interface SanitiseResult {
  bytes: PdfBytes;
  removed: SanitiseReport;
  /** True when nothing hidden was found, so the document was already clean. */
  wasClean: boolean;
}

const INFO_FIELDS = [
  "Title",
  "Author",
  "Subject",
  "Keywords",
  "Creator",
  "Producer",
  "CreationDate",
  "ModDate",
  "Trapped",
] as const;

export async function sanitise(
  input: PdfBytes,
  options: SanitiseOptions = {},
): Promise<SanitiseResult> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const catalog = doc.catalog;
  const removed: SanitiseReport = {
    metadata: false,
    attachments: 0,
    scripts: 0,
    comments: 0,
    links: 0,
  };

  if (options.metadata ?? true) {
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    if (info instanceof PDFDict) {
      for (const field of INFO_FIELDS) {
        if (info.get(PDFName.of(field)) !== undefined) {
          info.delete(PDFName.of(field));
          removed.metadata = true;
        }
      }
    }
    // The XMP packet says the same things again, in XML, and is what most
    // tools actually read.
    if (catalog.get(PDFName.of("Metadata")) !== undefined) {
      catalog.delete(PDFName.of("Metadata"));
      removed.metadata = true;
    }
  }

  const names = catalog.lookup(PDFName.of("Names"));

  if (options.attachments ?? true) {
    if (names instanceof PDFDict && names.get(PDFName.of("EmbeddedFiles")) !== undefined) {
      names.delete(PDFName.of("EmbeddedFiles"));
      removed.attachments++;
    }
    // A file can also be attached to a page as an annotation.
    removed.attachments += removeAnnotations(doc, (subtype) => subtype === "FileAttachment");
  }

  if (options.scripts ?? true) {
    if (names instanceof PDFDict && names.get(PDFName.of("JavaScript")) !== undefined) {
      names.delete(PDFName.of("JavaScript"));
      removed.scripts++;
    }
    // Something that runs when the document opens.
    if (catalog.get(PDFName.of("OpenAction")) !== undefined) {
      catalog.delete(PDFName.of("OpenAction"));
      removed.scripts++;
    }
    // Additional actions, on the document and on every page: open, close,
    // print, and the rest.
    if (catalog.get(PDFName.of("AA")) !== undefined) {
      catalog.delete(PDFName.of("AA"));
      removed.scripts++;
    }
    for (const page of doc.getPages()) {
      if (page.node.get(PDFName.of("AA")) !== undefined) {
        page.node.delete(PDFName.of("AA"));
        removed.scripts++;
      }
    }
    // Scripts hanging off form fields, which is where most of them live. A
    // field is a tree — a parent with kids, or one dict being both — and the
    // action can be on any node of it, so the whole tree is walked. The widget
    // annotations on each page are walked too, because a field's kid is a
    // widget and the two are often the same object.
    const form = catalog.lookup(PDFName.of("AcroForm"));
    if (form instanceof PDFDict) {
      const fields = form.lookup(PDFName.of("Fields"));
      if (fields instanceof PDFArray) {
        for (const ref of fields.asArray()) {
          if (ref instanceof PDFRef || ref instanceof PDFDict) {
            removed.scripts += stripActions(doc, ref);
          }
        }
      }
    }
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      for (const ref of annots?.asArray() ?? []) {
        const annot = doc.context.lookup(ref);
        if (annot instanceof PDFDict) removed.scripts += stripActions(doc, annot, false);
      }
    }
  }

  if (options.comments) {
    removed.comments += removeAnnotations(
      doc,
      (subtype) => subtype !== "Link" && subtype !== "Widget",
    );
  }

  if (options.links) {
    removed.links += removeAnnotations(doc, (subtype) => subtype === "Link");
  }

  const bytes = await doc.save();
  const wasClean =
    !removed.metadata &&
    removed.attachments === 0 &&
    removed.scripts === 0 &&
    removed.comments === 0 &&
    removed.links === 0;
  return { bytes, removed, wasClean };
}

/**
 * Removes the actions on a field or annotation, and on its kids. Returns how
 * many were there.
 */
function stripActions(doc: PDFDocument, ref: PDFRef | PDFDict, descend = true): number {
  const node = ref instanceof PDFDict ? ref : doc.context.lookup(ref);
  if (!(node instanceof PDFDict)) return 0;
  let gone = 0;
  for (const key of ["AA", "A"] as const) {
    if (node.get(PDFName.of(key)) !== undefined) {
      node.delete(PDFName.of(key));
      gone++;
    }
  }
  if (descend) {
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) {
      for (const kid of kids.asArray()) {
        if (kid instanceof PDFRef || kid instanceof PDFDict) gone += stripActions(doc, kid);
      }
    }
  }
  return gone;
}

/** Drops the annotations a predicate picks out, and says how many went. */
function removeAnnotations(doc: PDFDocument, wanted: (subtype: string) => boolean): number {
  let gone = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep = annots.asArray().filter((ref) => {
      const annot = doc.context.lookup(ref);
      if (!(annot instanceof PDFDict)) return true;
      const subtype = annot.get(PDFName.of("Subtype"));
      const name = subtype instanceof PDFName ? subtype.asString().replace(/^\//, "") : "";
      if (wanted(name)) {
        gone++;
        return false;
      }
      return true;
    });
    page.node.set(PDFName.of("Annots"), doc.context.obj(keep));
  }
  return gone;
}

/** What a document is carrying, without changing it. */
export async function findHidden(input: PdfBytes): Promise<SanitiseReport> {
  const { removed } = await sanitise(input, {
    metadata: true,
    attachments: true,
    scripts: true,
    comments: true,
    links: true,
  });
  return removed;
}
