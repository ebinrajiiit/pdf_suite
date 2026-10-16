import { expect, test } from "vitest";
import { insertPages, isIdentity, movePage, pagesAt, removePages } from "./page-order.js";

test("movePage moves forwards and backwards", () => {
  expect(movePage([0, 1, 2], 0, 2)).toEqual([1, 2, 0]);
  expect(movePage([0, 1, 2], 2, 0)).toEqual([2, 0, 1]);
});

test("movePage leaves the order alone when the move is a no-op or out of range", () => {
  const order = [0, 1, 2];
  expect(movePage(order, 1, 1)).toBe(order);
  expect(movePage(order, 0, 3)).toBe(order);
  expect(movePage(order, -1, 0)).toBe(order);
});

test("removePages drops by display position, not by page number", () => {
  // Order [2,0,1]: dropping position 0 drops source page 2.
  expect(removePages([2, 0, 1], [0])).toEqual([0, 1]);
  expect(removePages([0, 1, 2, 3], [1, 3])).toEqual([0, 2]);
  expect(removePages([0, 1], [])).toEqual([0, 1]);
});

test("insertPages puts pages at a position or appends", () => {
  expect(insertPages([0, 1], [5, 6], 1)).toEqual([0, 5, 6, 1]);
  expect(insertPages([0, 1], [5], 0)).toEqual([5, 0, 1]);
  expect(insertPages([0, 1], [5])).toEqual([0, 1, 5]);
  // Past the end appends rather than throwing.
  expect(insertPages([0, 1], [5], 9)).toEqual([0, 1, 5]);
});

test("pagesAt returns source pages in display order", () => {
  expect(pagesAt([2, 0, 1], [0, 2])).toEqual([2, 1]);
  expect(pagesAt([2, 0, 1], [])).toEqual([]);
});

test("isIdentity only accepts a full, in-order document", () => {
  expect(isIdentity([0, 1, 2], 3)).toBe(true);
  expect(isIdentity([0, 2, 1], 3)).toBe(false);
  // A deletion is not the identity even though it is in order.
  expect(isIdentity([0, 1], 3)).toBe(false);
});
