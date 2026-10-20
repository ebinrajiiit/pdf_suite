import { expect, test } from "vitest";
import type { OutlineItem } from "@pdf-suite/engine";
import { addBookmark, moveAt, removeAt, renameAt } from "./outline-edit.js";

const tree = (): OutlineItem[] => [
  { title: "One", page: 0, children: [] },
  {
    title: "Two",
    page: 1,
    children: [
      { title: "Two a", page: 2, children: [] },
      { title: "Two b", page: 3, children: [] },
    ],
  },
  { title: "Three", page: 4, children: [] },
];

test("renames by path, not by title", () => {
  const out = renameAt(tree(), [1, 0], "Renamed");
  expect(out[1]?.children[0]?.title).toBe("Renamed");
  // Everything else is as it was, including the original.
  expect(out[1]?.children[1]?.title).toBe("Two b");
  expect(tree()[1]?.children[0]?.title).toBe("Two a");
});

test("removing takes the branch under it", () => {
  const out = removeAt(tree(), [1]);
  expect(out.map((item) => item.title)).toEqual(["One", "Three"]);
});

test("moving stays within its own level, and stops at the ends", () => {
  expect(moveAt(tree(), [0], 1).map((item) => item.title)).toEqual(["Two", "One", "Three"]);
  expect(moveAt(tree(), [0], -1).map((item) => item.title)).toEqual(["One", "Two", "Three"]);
  expect(moveAt(tree(), [2], 1).map((item) => item.title)).toEqual(["One", "Two", "Three"]);
  expect(moveAt(tree(), [1, 1], -1)[1]?.children.map((item) => item.title)).toEqual([
    "Two b",
    "Two a",
  ]);
});

test("adding puts it at the end of the top level", () => {
  const out = addBookmark(tree(), "Four", 5);
  expect(out).toHaveLength(4);
  expect(out[3]).toEqual({ title: "Four", page: 5, children: [] });
});

test("a path that does not exist changes nothing", () => {
  expect(renameAt(tree(), [9], "x")).toEqual(tree());
  expect(removeAt(tree(), [])).toEqual(tree());
  expect(moveAt(tree(), [], 1)).toEqual(tree());
});
