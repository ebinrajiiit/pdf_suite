import { PDFDocument } from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * Images into a PDF. The common institutional case is a phone photo or a flatbed
 * scan of a form that has to become a document, so each image gets its own page
 * at its own aspect ratio rather than being letterboxed into A4.
 */

export interface SourceImage {
  bytes: Uint8Array;
  /** MIME type, or a filename to infer it from. */
  type: string;
}

/** Page size in points, when a fixed page is wanted instead of one per image. */
export interface PageBox {
  width: number;
  height: number;
  /** Points of white space kept around the image. */
  margin?: number;
}

export interface ImagesToPdfOptions {
  /** Fit every image onto this page size instead of sizing pages to images. */
  page?: PageBox;
  /** Points per pixel. 0.75 maps 96 dpi pixels to points; smaller means denser. */
  pointsPerPixel?: number;
}

const JPEG = /\.jpe?g$|^image\/jpe?g$/i;
const PNG = /\.png$|^image\/png$/i;

/** True for the formats pdf-lib can embed, so callers can filter a drop. */
export function isSupportedImage(type: string): boolean {
  return JPEG.test(type) || PNG.test(type);
}

export async function imagesToPdf(
  images: SourceImage[],
  options: ImagesToPdfOptions = {},
): Promise<PdfBytes> {
  if (images.length === 0) throw new Error("no images to convert");
  const doc = await PDFDocument.create();
  const perPixel = options.pointsPerPixel ?? 0.75;

  for (const image of images) {
    const embedded = JPEG.test(image.type)
      ? await doc.embedJpg(image.bytes)
      : PNG.test(image.type)
        ? await doc.embedPng(image.bytes)
        : undefined;
    if (!embedded) {
      throw new Error(`${image.type} is not a JPEG or PNG; convert it first`);
    }

    if (!options.page) {
      const page = doc.addPage([embedded.width * perPixel, embedded.height * perPixel]);
      page.drawImage(embedded, {
        x: 0,
        y: 0,
        width: page.getWidth(),
        height: page.getHeight(),
      });
      continue;
    }

    const { width, height, margin = 0 } = options.page;
    const page = doc.addPage([width, height]);
    const room = { width: width - margin * 2, height: height - margin * 2 };
    // Contain, never crop: a scanned form must not lose its edges.
    const scale = Math.min(room.width / embedded.width, room.height / embedded.height);
    const drawn = { width: embedded.width * scale, height: embedded.height * scale };
    page.drawImage(embedded, {
      x: (width - drawn.width) / 2,
      y: (height - drawn.height) / 2,
      width: drawn.width,
      height: drawn.height,
    });
  }

  return doc.save();
}
