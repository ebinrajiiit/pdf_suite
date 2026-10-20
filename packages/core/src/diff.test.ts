import { expect, test } from "vitest";
import { diffDocuments, diffWords } from "./diff.js";

test("finds the words that went and the words that arrived", () => {
  const { added, removed } = diffWords(
    "the meeting is on Tuesday at ten".split(" "),
    "the meeting is on Thursday at ten".split(" "),
  );
  expect(removed).toEqual(["Tuesday"]);
  expect(added).toEqual(["Thursday"]);
});

test("keeps a changed phrase together rather than reporting word by word", () => {
  const { added, removed } = diffWords(
    "fees are due before the first of May".split(" "),
    "fees are due before the last working day of May".split(" "),
  );
  expect(removed).toEqual(["first"]);
  expect(added).toEqual(["last working day"]);
});

test("an unchanged page reports nothing at all", () => {
  expect(diffWords(["same", "words"], ["same", "words"])).toEqual({ added: [], removed: [] });
});

test("an emptied page is all removal, a new page all addition", () => {
  expect(diffWords(["gone"], [])).toEqual({ added: [], removed: ["gone"] });
  expect(diffWords([], ["new"])).toEqual({ added: ["new"], removed: [] });
});

test("compares page by page and counts what changed", () => {
  const diff = diffDocuments(
    ["Circular 12 of 2026", "Fees are due in May", "Signed"],
    ["Circular 12 of 2026", "Fees are due in June", "Signed"],
  );
  expect(diff.changed).toBe(1);
  expect(diff.pages[0]?.same).toBe(true);
  expect(diff.pages[1]?.removed).toEqual(["May"]);
  expect(diff.pages[1]?.added).toEqual(["June"]);
  expect(diff.onlyHere).toEqual([]);
});

test("says which pages one document has and the other does not", () => {
  const diff = diffDocuments(["One"], ["One", "Two", "Three"]);
  // Pages 2 and 3 exist only in the newer document.
  expect(diff.onlyHere).toEqual([1, 2]);
  expect(diff.onlyThere).toEqual([]);
  expect(diff.pages).toHaveLength(1);
});

test("a page far too long to diff is reported as wholly changed, not hung on", () => {
  const long = Array.from({ length: 2100 }, (_, i) => `word${i}`);
  const other = Array.from({ length: 2100 }, (_, i) => `other${i}`);
  const { added, removed } = diffWords(long, other);
  expect(added).toHaveLength(1);
  expect(removed).toHaveLength(1);
});
