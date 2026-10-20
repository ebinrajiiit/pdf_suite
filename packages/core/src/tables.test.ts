import { expect, test } from "vitest";
import { lines, tableFrom, toCsv, type TextRunLike } from "./tables.js";

/** A run of text on a page, as the engine reports one. */
const run = (text: string, x: number, y: number): TextRunLike => ({
  text,
  x,
  y,
  w: text.length * 6,
  h: 10,
});

/** A mark sheet: three columns, a heading row and three students. */
const markSheet = [
  run("Roll", 50, 700),
  run("Name", 150, 700),
  run("Marks", 350, 700),
  run("21CS01", 50, 680),
  run("A Student", 150, 680),
  run("88", 350, 680),
  run("21CS02", 50, 660),
  run("B Student", 150, 660),
  run("91", 350, 660),
];

test("runs on the same baseline are one line, in reading order", () => {
  const grouped = lines([run("second", 200, 700), run("first", 50, 700), run("below", 50, 660)]);
  expect(grouped).toHaveLength(2);
  expect(grouped[0]?.map((one) => one.text)).toEqual(["first", "second"]);
  expect(grouped[1]?.map((one) => one.text)).toEqual(["below"]);
});

test("a superscript does not start a line of its own", () => {
  const grouped = lines([run("Marks", 50, 700), { ...run("*", 90, 704), h: 6 }]);
  expect(grouped).toHaveLength(1);
});

test("finds the grid a mark sheet makes", () => {
  const table = tableFrom(markSheet)!;
  expect(table.rows).toHaveLength(3);
  expect(table.rows[0]).toEqual(["Roll", "Name", "Marks"]);
  expect(table.rows[2]).toEqual(["21CS02", "B Student", "91"]);
  // Every row filled every column, so this is as sure as it gets.
  expect(table.confidence).toBe(1);
});

test("a gap in the data leaves the cell empty rather than shifting the row", () => {
  const table = tableFrom([
    ...markSheet,
    run("21CS03", 50, 640),
    // No name recorded for this student.
    run("77", 350, 640),
  ])!;
  expect(table.rows[3]).toEqual(["21CS03", "", "77"]);
  expect(table.confidence).toBeLessThan(1);
});

test("prose is not a table", () => {
  // One column of running text: the left edges agree, so there is no second
  // column to find.
  const prose = [
    run("The council met on Tuesday and resolved", 50, 700),
    run("to raise the hostel fee from June.", 50, 686),
  ];
  expect(tableFrom(prose)).toBeUndefined();
});

test("a single row is not a table either", () => {
  expect(tableFrom([run("Roll", 50, 700), run("Name", 150, 700)])).toBeUndefined();
});

test("the CSV quotes what a spreadsheet would otherwise misread", () => {
  const csv = toCsv([
    ["Roll", "Name", "Note"],
    ["21CS01", "Student, A", 'said "yes"'],
    ["21CS02", "B Student", "line one\nline two"],
  ]);
  expect(csv.split("\n")[0]).toBe("Roll,Name,Note");
  expect(csv).toContain('"Student, A"');
  expect(csv).toContain('"said ""yes"""');
  expect(csv).toContain('"line one\nline two"');
});
