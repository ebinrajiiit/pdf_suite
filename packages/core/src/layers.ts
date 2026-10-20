import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * Optional content groups — layers, as every drawing program calls them.
 *
 * A plan from an architect arrives with the electrical, plumbing and structural
 * work on separate layers, and the question before sending it to a contractor
 * is which of them the contractor should see. Acrobat's layers panel answers
 * it; this is that panel's two useful operations.
 *
 * Turning a layer off sets the document's default configuration, which is what
 * a reader honours when it opens the file. The content is still in the file —
 * this hides, it does not remove, exactly as cropping does, and the UI says so.
 * Flattening layers away is a separate job and is not done here.
 */

export interface Layer {
  /** Identifies the layer for turning it on and off. */
  id: string;
  name: string;
  visible: boolean;
}

/** The document's layers, with whether each is on by default. */
export async function readLayers(input: PdfBytes): Promise<Layer[]> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const properties = doc.catalog.lookup(PDFName.of("OCProperties"));
  if (!(properties instanceof PDFDict)) return [];

  const groups = properties.lookup(PDFName.of("OCGs"));
  if (!(groups instanceof PDFArray)) return [];

  const config = properties.lookup(PDFName.of("D"));
  const off = new Set(
    config instanceof PDFDict && config.lookup(PDFName.of("OFF")) instanceof PDFArray
      ? (config.lookup(PDFName.of("OFF")) as PDFArray).asArray().map((ref) => String(ref))
      : [],
  );

  return groups.asArray().map((ref) => {
    const group = doc.context.lookup(ref);
    const name = group instanceof PDFDict ? group.lookup(PDFName.of("Name")) : undefined;
    return {
      id: String(ref),
      name:
        name instanceof PDFString || name instanceof PDFHexString
          ? name.decodeText()
          : "Unnamed layer",
      visible: !off.has(String(ref)),
    };
  });
}

/**
 * Turns layers on and off, by the ids `readLayers` reported.
 *
 * The result is what a reader shows when it opens the file; the hidden
 * content is still there, and `sanitise` is what removes hidden layers for
 * good.
 */
export async function setLayerVisibility(
  input: PdfBytes,
  visibility: Record<string, boolean>,
): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const properties = doc.catalog.lookup(PDFName.of("OCProperties"));
  if (!(properties instanceof PDFDict)) throw new Error("this document has no layers");

  const groups = properties.lookup(PDFName.of("OCGs"));
  if (!(groups instanceof PDFArray)) throw new Error("this document has no layers");

  const config = properties.lookup(PDFName.of("D"));
  const configDict = config instanceof PDFDict ? config : doc.context.obj({});
  if (!(config instanceof PDFDict)) properties.set(PDFName.of("D"), configDict);

  const previouslyOff = new Set(
    configDict.lookup(PDFName.of("OFF")) instanceof PDFArray
      ? (configDict.lookup(PDFName.of("OFF")) as PDFArray).asArray().map((ref) => String(ref))
      : [],
  );

  const known = new Set(groups.asArray().map((ref) => String(ref)));
  for (const id of Object.keys(visibility)) {
    if (!known.has(id)) throw new Error(`this document has no layer ${id}`);
  }

  const off = groups.asArray().filter((ref) => {
    const id = String(ref);
    const wanted = visibility[id];
    return wanted === undefined ? previouslyOff.has(id) : !wanted;
  });

  if (off.length === 0) configDict.delete(PDFName.of("OFF"));
  else configDict.set(PDFName.of("OFF"), doc.context.obj(off));
  // A configuration with no base state shows everything not listed as off.
  if (configDict.get(PDFName.of("BaseState")) === undefined) {
    configDict.set(PDFName.of("BaseState"), PDFName.of("ON"));
  }

  return doc.save();
}
