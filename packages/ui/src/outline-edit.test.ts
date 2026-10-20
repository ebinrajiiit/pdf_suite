import { expect, test } from "vitest";
import type { OutlineItem } from "@pdf-suite/engine";
import { addBookmark, indentAt, moveAt, outdentAt, removeAt, renameAt } from "./outline-edit.js";

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

test("indenting makes a bookmark a child of the one above it", () => {
  const out = indentAt(tree(), [2]);
  expect(out.map((item) => item.title)).toEqual(["One", "Two"]);
  // "Three" is now the last child of "Two", after its own children.
  expect(out[1]?.children.map((item) => item.title)).toEqual(["Two a", "Two b", "Three"]);
});

test("the first entry of a level has nothing to indent under", () => {
  expect(indentAt(tree(), [0])).toEqual(tree());
  expect(indentAt(tree(), [1, 0])).toEqual(tree());
});

test("outdenting lifts a bookmark to its parent's level, after the parent", () => {
  const out = outdentAt(tree(), [1, 0]);
  expect(out.map((item) => item.title)).toEqual(["One", "Two", "Two a", "Three"]);
  expect(out[1]?.children.map((item) => item.title)).toEqual(["Two b"]);
});

test("a top-level bookmark has nowhere further out to go", () => {
  expect(outdentAt(tree(), [0])).toEqual(tree());
  expect(outdentAt(tree(), [])).toEqual(tree());
});

test("indent then outdent puts a bookmark back where it was", () => {
  const indented = indentAt(tree(), [2]);
  const back = outdentAt(indented, [1, 2]);
  expect(back.map((item) => item.title)).toEqual(["One", "Two", "Three"]);
  expect(back[1]?.children.map((item) => item.title)).toEqual(["Two a", "Two b"]);
});
