import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * Writing the document's bookmarks — the `/Outlines` tree.
 *
 * Reading them is the engine's job; writing them is here, because it is pure
 * document structure and pdf-lib offers no helper for it. The whole tree is
 * written at once rather than patched: the panel edits a list and hands the
 * list back, which keeps one shape of truth instead of a pile of operations
 * that each have to find their node again.
 *
 * Each bookmark points at a page with an explicit destination — `[page /XYZ
 * null null null]`, meaning "this page, keep the current view" — rather than a
 * named destination, so nothing has to be resolved through the name tree.
 */

export interface Bookmark {
  title: string;
  /**
   * Source page index. Out-of-range pages are refused rather than silently
   * dropped. A bookmark without one is written as a heading with no
   * destination, which is what a document's own structure sometimes has and
   * what would otherwise be lost on every save.
   */
  page?: number | undefined;
  children?: Bookmark[];
}

/** Replaces the document's bookmarks with the tree given. */
export async function setOutline(input: PdfBytes, bookmarks: Bookmark[]): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const context = doc.context;
  const pages = doc.getPages();

  if (bookmarks.length === 0) {
    doc.catalog.delete(PDFName.of("Outlines"));
    doc.catalog.delete(PDFName.of("PageMode"));
    return doc.save();
  }

  const root = context.obj({ Type: "Outlines" });
  const rootRef = context.register(root);

  /**
   * Writes one level and links it up. Returns the first and last child refs and
   * how many entries are open below this point, which is what `/Count` means.
   */
  const level = (
    items: Bookmark[],
    parent: PDFRef,
  ): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = items.map(() => context.nextRef());
    let total = 0;

    items.forEach((item, index) => {
      if (
        item.page !== undefined &&
        (!Number.isInteger(item.page) || item.page < 0 || item.page >= pages.length)
      ) {
        throw new RangeError(`bookmark page ${item.page} outside a ${pages.length}-page document`);
      }
      const ref = refs[index]!;
      const node = context.obj({
        Title: PDFString.of(item.title),
        Parent: parent,
        ...(item.page === undefined
          ? {}
          : { Dest: [pages[item.page]!.ref, PDFName.of("XYZ"), null, null, null] }),
      });
      if (index > 0) node.set(PDFName.of("Prev"), refs[index - 1]!);
      if (index < refs.length - 1) node.set(PDFName.of("Next"), refs[index + 1]!);
      context.assign(ref, node);

      const children = item.children ?? [];
      if (children.length > 0) {
        const inner = level(children, ref);
        node.set(PDFName.of("First"), inner.first);
        node.set(PDFName.of("Last"), inner.last);
        // Positive: the branch opens with the document, as Acrobat's do.
        node.set(PDFName.of("Count"), PDFNumber.of(inner.count));
        total += inner.count;
      }
      total += 1;
    });

    return { first: refs[0]!, last: refs[refs.length - 1]!, count: total };
  };

  const top = level(bookmarks, rootRef);
  root.set(PDFName.of("First"), top.first);
  root.set(PDFName.of("Last"), top.last);
  root.set(PDFName.of("Count"), PDFNumber.of(top.count));
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
  // Open the panel when the document opens, which is what a document with
  // bookmarks is for.
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));

  return doc.save();
}

/** True when the document has an outline tree at all. */
export async function hasOutline(input: PdfBytes): Promise<boolean> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const outlines = doc.catalog.lookup(PDFName.of("Outlines"));
  return outlines instanceof PDFDict && outlines.get(PDFName.of("First")) !== undefined;
}
