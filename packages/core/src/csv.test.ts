import { expect, test } from "vitest";
import { matchColumns, nameFor, parseCsv, valuesFor } from "./csv.js";

test("reads a plain spreadsheet export", () => {
  const sheet = parseCsv("roll,name,marks\n21CS01,A Student,88\n21CS02,B Student,91\n");
  expect(sheet.columns).toEqual(["roll", "name", "marks"]);
  expect(sheet.rows).toHaveLength(2);
  expect(sheet.rows[1]).toEqual({ roll: "21CS02", name: "B Student", marks: "91" });
});

test("a comma inside a name does not become a new column", () => {
  const sheet = parseCsv('roll,name\n21CS01,"Student, A"\n');
  expect(sheet.rows[0]?.name).toBe("Student, A");
});

test("quotes, newlines and doubled quotes inside a field survive", () => {
  const sheet = parseCsv('id,note\n1,"line one\nline two"\n2,"she said ""yes"""\n');
  expect(sheet.rows[0]?.note).toBe("line one\nline two");
  expect(sheet.rows[1]?.note).toBe('she said "yes"');
});

test("a byte-order mark does not become part of the first column's name", () => {
  const sheet = parseCsv("﻿roll,name\n1,A\n");
  expect(sheet.columns[0]).toBe("roll");
});

test("blank trailing lines are not people", () => {
  const sheet = parseCsv("roll,name\n1,A\n\n\n");
  expect(sheet.rows).toHaveLength(1);
});

test("columns match fields through the punctuation people put in field names", () => {
  const { pairs, unmatchedColumns, unfilledFields } = matchColumns(
    ["Roll Number", "Student Name", "House"],
    ["roll.number", "student_name", "course"],
  );
  expect(pairs).toEqual({ "Roll Number": "roll.number", "Student Name": "student_name" });
  // Reported, not dropped: a column nobody noticed was ignored is how a
  // hundred certificates go out with a blank on them.
  expect(unmatchedColumns).toEqual(["House"]);
  expect(unfilledFields).toEqual(["course"]);
});

test("yes and no fill a tick box, anything else is text", () => {
  const values = valuesFor(
    { agree: "Yes", declined: "no", name: "A Student", marks: "88" },
    { agree: "agree", declined: "declined", name: "name", marks: "marks" },
  );
  expect(values).toEqual({ agree: true, declined: false, name: "A Student", marks: "88" });
});

test("each row gets a file name from whatever looks like a name or a roll", () => {
  expect(nameFor({ roll: "21CS01", marks: "88" }, 0)).toBe("21CS01");
  expect(nameFor({ "Student Name": "A Student" }, 3)).toBe("A Student");
  expect(nameFor({ marks: "88" }, 4)).toBe("row-5");
  // Nothing that could be a path.
  expect(nameFor({ name: "../../etc/passwd" }, 0)).toBe("etcpasswd");
});
