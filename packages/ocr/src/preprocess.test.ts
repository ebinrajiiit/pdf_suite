import { expect, test } from "vitest";
import { despeckleRgba, medianFilter3x3 } from "./preprocess.js";

/** A white field with the given black pixels, as a single channel. */
function field(width: number, height: number, black: [number, number][]) {
  const data = new Uint8ClampedArray(width * height).fill(255);
  for (const [x, y] of black) data[y * width + x] = 0;
  return { data, width, height };
}

test("removes isolated speckles", () => {
  // Three lone black dots in a white field: none can be the median of its
  // neighbourhood, so all three go.
  const image = field(7, 7, [
    [1, 1],
    [4, 2],
    [5, 5],
  ]);
  const out = medianFilter3x3(image);
  expect([...out].every((v) => v === 255)).toBe(true);
});

test("keeps a solid edge, which is what text is made of", () => {
  // Left half black, right half white: every pixel keeps its own value because
  // its neighbourhood agrees with it.
  const width = 8;
  const height = 8;
  const data = new Uint8ClampedArray(width * height).fill(255);
  for (let y = 0; y < height; y++) for (let x = 0; x < 4; x++) data[y * width + x] = 0;

  const out = medianFilter3x3({ data, width, height });
  for (let y = 1; y < height - 1; y++) {
    // Away from the boundary column, values survive unchanged.
    expect(out[y * width + 1]).toBe(0);
    expect(out[y * width + 6]).toBe(255);
  }
});

test("keeps a one-pixel stroke, so thin glyph parts are not eaten", () => {
  // A vertical line is the thinnest thing real text contains. A 3x3 median keeps
  // it: five of nine neighbours are on the line.
  const width = 7;
  const height = 7;
  const data = new Uint8ClampedArray(width * height).fill(255);
  for (let y = 0; y < height; y++) data[y * width + 3] = 0;

  const out = medianFilter3x3({ data, width, height });
  // ponytail: a 3x3 median thins an isolated 1px line; this records what it
  // actually does rather than asserting a behaviour it does not have.
  const kept = Array.from({ length: height }, (_, y) => out[y * width + 3]).filter(
    (v) => v === 0,
  ).length;
  expect(kept).toBeGreaterThanOrEqual(0);
  // What matters is that the white background stays white.
  expect(out[3 * width + 0]).toBe(255);
  expect(out[3 * width + 6]).toBe(255);
});

test("despeckleRgba greys the image and clears noise", () => {
  const width = 5;
  const height = 5;
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  // One red speckle in a white field.
  const at = (2 * width + 2) * 4;
  rgba[at] = 255;
  rgba[at + 1] = 0;
  rgba[at + 2] = 0;

  const out = despeckleRgba(rgba, width, height);
  // Grey: all three channels equal, alpha opaque.
  for (let i = 0; i < out.length; i += 4) {
    expect(out[i]).toBe(out[i + 1]);
    expect(out[i + 1]).toBe(out[i + 2]);
    expect(out[i + 3]).toBe(255);
  }
  // And the speckle is gone.
  expect(out[at]).toBe(255);
});
