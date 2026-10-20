import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * Links: the boxes that take a reader somewhere else.
 *
 * A table of contents that cannot be clicked is a list of page numbers, and
 * every institutional report has one. This writes both kinds a document needs:
 * a jump to another page of the same file, and a web address.
 *
 * Named destinations come with them. A link to a name rather than a page
 * survives pages being inserted before it, which is why a long report's
 * internal references should use one.
 */

export interface LinkTarget {
  /** A page of this document, by source index. */
  page?: number | undefined;
  /** A named destination in this document. */
  destination?: string | undefined;
  /** A web address. Opening one is the reader's decision, never automatic. */
  url?: string | undefined;
}

export interface Link {
  /** Source page the link sits on. */
  page: number;
  /** Index among that page's `/Annots`. */
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  target: LinkTarget;
}

/** Adds a link box to a page. */
export async function addLink(
  input: PdfBytes,
  link: { page: number; x: number; y: number; w: number; h: number; target: LinkTarget },
): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const count = doc.getPageCount();
  if (!Number.isInteger(link.page) || link.page < 0 || link.page >= count) {
    throw new RangeError(`page ${link.page} outside a ${count}-page document`);
  }
  if (link.w < 2 || link.h < 2) throw new Error("a link has to be big enough to click");

  const { page, destination, url } = link.target;
  if (page === undefined && !destination && !url) {
    throw new Error("a link needs somewhere to go");
  }
  if (page !== undefined && (!Number.isInteger(page) || page < 0 || page >= count)) {
    throw new RangeError(`link target page ${page} outside a ${count}-page document`);
  }
  if (url !== undefined && !/^https?:\/\/|^mailto:/i.test(url)) {
    // Anything else — javascript:, file:, data: — is a way to make a document
    // do something when a reader clicks it, which this will not write.
    throw new Error("a link can only go to http, https or mailto");
  }

  const node = doc.getPage(link.page).node;
  const action =
    url !== undefined
      ? { S: "URI", URI: PDFString.of(url) }
      : destination
        ? { S: "GoTo", D: PDFString.of(destination) }
        : {
            S: "GoTo",
            D: [doc.getPage(page!).ref, PDFName.of("XYZ"), null, null, null],
          };

  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [link.x, link.y, link.x + link.w, link.y + link.h],
    // No visible border: Acrobat's default, and a box drawn round every link
    // in a contents page looks like a fault.
    Border: [0, 0, 0],
    F: 4,
    A: action,
  });

  const existing = node.Annots()?.asArray() ?? [];
  node.set(PDFName.of("Annots"), doc.context.obj([...existing, doc.context.register(annot)]));
  return doc.save();
}

/** Every link in the document, with where it goes. */
export async function readLinks(input: PdfBytes): Promise<Link[]> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const pageRefs = doc.getPages().map((page) => String(page.ref));
  const links: Link[] = [];

  doc.getPages().forEach((page, pageIndex) => {
    page.node
      .Annots()
      ?.asArray()
      .forEach((ref, index) => {
        const annot = doc.context.lookup(ref);
        if (!(annot instanceof PDFDict)) return;
        if (String(annot.get(PDFName.of("Subtype"))) !== "/Link") return;

        const rect = annot.lookup(PDFName.of("Rect"));
        const numbers =
          rect instanceof PDFArray ? rect.asArray().map((value) => Number(value.toString())) : [];
        const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = numbers;

        links.push({
          page: pageIndex,
          index,
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
          target: targetOf(doc, annot, pageRefs),
        });
      });
  });

  return links;
}

function targetOf(doc: PDFDocument, annot: PDFDict, pageRefs: string[]): LinkTarget {
  const action = annot.lookup(PDFName.of("A"));
  if (action instanceof PDFDict) {
    const kind = String(action.get(PDFName.of("S")));
    if (kind === "/URI") {
      const uri = action.lookup(PDFName.of("URI"));
      return {
        url: uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText() : "",
      };
    }
    const dest = action.get(PDFName.of("D"));
    return destinationOf(doc, dest, pageRefs);
  }
  return destinationOf(doc, annot.get(PDFName.of("Dest")), pageRefs);
}

function destinationOf(doc: PDFDocument, dest: unknown, pageRefs: string[]): LinkTarget {
  if (dest === undefined) return {};
  const resolved = doc.context.lookup(dest as never);
  if (resolved instanceof PDFArray) {
    const page = pageRefs.indexOf(String(resolved.get(0)));
    return page >= 0 ? { page } : {};
  }
  if (dest instanceof PDFString || dest instanceof PDFHexString) {
    return { destination: dest.decodeText() };
  }
  return {};
}

/**
 * Sets the document's named destinations, replacing what is there.
 *
 * A name is a stable handle on a place in the document: links and bookmarks
 * that use one keep working when pages are inserted before it.
 */
export async function setDestinations(
  input: PdfBytes,
  destinations: { name: string; page: number }[],
): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const count = doc.getPageCount();

  const names = doc.catalog.lookup(PDFName.of("Names"));
  const namesDict = names instanceof PDFDict ? names : doc.context.obj({});
  if (!(names instanceof PDFDict)) {
    doc.catalog.set(PDFName.of("Names"), namesDict);
  }

  if (destinations.length === 0) {
    namesDict.delete(PDFName.of("Dests"));
    return doc.save();
  }

  const pairs: unknown[] = [];
  // A name tree's /Names array has to be sorted by name, or readers binary
  // search it and miss.
  for (const { name, page } of [...destinations].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!Number.isInteger(page) || page < 0 || page >= count) {
      throw new RangeError(`destination page ${page} outside a ${count}-page document`);
    }
    if (name.trim() === "") throw new Error("a destination needs a name");
    pairs.push(
      PDFString.of(name),
      doc.context.obj([doc.getPage(page).ref, PDFName.of("XYZ"), null, null, null]),
    );
  }

  namesDict.set(PDFName.of("Dests"), doc.context.obj({ Names: pairs as never }));
  return doc.save();
}

/** The document's named destinations. */
export async function readDestinations(input: PdfBytes): Promise<{ name: string; page: number }[]> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const names = doc.catalog.lookup(PDFName.of("Names"));
  if (!(names instanceof PDFDict)) return [];
  const dests = names.lookup(PDFName.of("Dests"));
  if (!(dests instanceof PDFDict)) return [];
  const list = dests.lookup(PDFName.of("Names"));
  if (!(list instanceof PDFArray)) return [];

  const pageRefs = doc.getPages().map((page) => String(page.ref));
  const out: { name: string; page: number }[] = [];
  for (let i = 0; i + 1 < list.size(); i += 2) {
    const key = list.lookup(i);
    const value = list.lookup(i + 1);
    if (!(value instanceof PDFArray)) continue;
    const page = pageRefs.indexOf(String(value.get(0)));
    if (page < 0) continue;
    out.push({
      name:
        key instanceof PDFString || key instanceof PDFHexString ? key.decodeText() : String(key),
      page,
    });
  }
  return out;
}
