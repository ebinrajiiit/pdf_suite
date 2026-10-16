/**
 * Scan clean-up before OCR.
 *
 * Measured, not assumed: `scripts/ocr-accuracy.mjs` showed Tesseract shrugging
 * off 2 px of blur, 5° of skew, JPEG at 60 % and a drop to 150 dpi, while 2 %
 * salt-and-pepper noise cost 11 points of accuracy and 8 % destroyed the page
 * entirely — 0 % accuracy, confidence 0. Speckle is the failure mode, so
 * despeckling is the preprocessing that earns its keep (ADR 0004).
 *
 * A median filter is the textbook answer for salt and pepper: an isolated black
 * dot in a white neighbourhood is never the median, so it disappears, while an
 * edge — where half the neighbours agree — survives.
 */

/** A bare image, so this stays testable without a canvas. */
export interface Gray {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * 3×3 median filter over a single channel.
 *
 * ponytail: a plain O(9n) median with an insertion sort of nine values. A
 * separable or histogram-based filter would be faster, but this is ~50 ms on a
 * 300 dpi A4 page and runs once per page inside a worker. Revisit if batch OCR
 * over hundreds of pages makes it show up in a profile.
 */
export function medianFilter3x3({ data, width, height }: Gray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  const window = new Uint8ClampedArray(9);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          window[n++] = data[yy * width + xx]!;
        }
      }
      // Insertion sort over at most nine values; the middle one is the median.
      for (let i = 1; i < n; i++) {
        const value = window[i]!;
        let j = i - 1;
        while (j >= 0 && window[j]! > value) {
          window[j + 1] = window[j]!;
          j--;
        }
        window[j + 1] = value;
      }
      out[y * width + x] = window[n >> 1]!;
    }
  }
  return out;
}

/**
 * Despeckles an RGBA image in place-ish: returns new RGBA data, grey, with the
 * median filter applied. Colour is dropped deliberately — Tesseract works on
 * intensity, and a grey page is a third of the bytes to filter.
 */
export function despeckleRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    // Rec. 601 luma, which is what every scanner and fax effectively uses.
    gray[p] = (rgba[i]! * 299 + rgba[i + 1]! * 587 + rgba[i + 2]! * 114) / 1000;
  }

  const filtered = medianFilter3x3({ data: gray, width, height });

  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0, p = 0; i < out.length; i += 4, p++) {
    const v = filtered[p]!;
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
}

/** Applies despeckling to a canvas, returning a new one. */
export function despeckleCanvas(source: OffscreenCanvas): OffscreenCanvas {
  const ctx = source.getContext("2d");
  if (!ctx) throw new Error("could not get a 2D context");
  const image = ctx.getImageData(0, 0, source.width, source.height);
  const cleaned = despeckleRgba(image.data, source.width, source.height);

  const target = new OffscreenCanvas(source.width, source.height);
  const targetCtx = target.getContext("2d");
  if (!targetCtx) throw new Error("could not get a 2D context");
  // ImageData wants a Uint8ClampedArray over a plain ArrayBuffer.
  targetCtx.putImageData(
    new ImageData(new Uint8ClampedArray(cleaned), source.width, source.height),
    0,
    0,
  );
  return target;
}
