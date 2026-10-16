import { expect, test } from "vitest";
import { visibleRange } from "./use-visible-range.js";

// Five 100px items: offsets are cumulative, so the last entry is the total.
const offsets = [0, 100, 200, 300, 400, 500];

test("mounts the items in view plus the look-ahead", () => {
  expect(visibleRange(offsets, 0, 250)).toEqual({ start: 0, end: 3 });
  expect(visibleRange(offsets, 200, 100)).toEqual({ start: 1, end: 3 });
});

test("clamps at both ends rather than returning out-of-range indices", () => {
  // Only item 0 is in a 100px viewport at the top, so the window is 0 plus one.
  expect(visibleRange(offsets, 0, 100)).toEqual({ start: 0, end: 1 });
  expect(visibleRange(offsets, 450, 100)).toEqual({ start: 3, end: 4 });
  // Scrolled past the end (can happen mid-resize) must still name a real item.
  expect(visibleRange(offsets, 10_000, 100)).toEqual({ start: 3, end: 4 });
});

test("an item boundary belongs to the item starting there", () => {
  // At scroll 100 exactly, item 1 is the first visible one, not item 0.
  expect(visibleRange(offsets, 100, 100, 0)).toEqual({ start: 1, end: 1 });
});

test("zero height still mounts the item under the scroll position", () => {
  expect(visibleRange(offsets, 250, 0, 0)).toEqual({ start: 2, end: 2 });
});

test("an empty list yields an empty range instead of index 0", () => {
  expect(visibleRange([0], 0, 500)).toEqual({ start: 0, end: -1 });
  expect(visibleRange([], 0, 500)).toEqual({ start: 0, end: -1 });
});
