import { PDFDocument, StandardFonts } from "pdf-lib";
import { expect, test } from "vitest";
import { fillForm, readForm } from "./forms.js";

/** A document with one field of each kind we support, across two pages. */
async function makeForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([400, 400]);
  const second = doc.addPage([400, 400]);
  const form = doc.getForm();

  const name = form.createTextField("student.name");
  name.setText("");
  name.addToPage(first, { x: 40, y: 340, width: 220, height: 20, font });

  const remarks = form.createTextField("student.remarks");
  remarks.enableMultiline();
  remarks.addToPage(first, { x: 40, y: 260, width: 220, height: 60, font });

  const passed = form.createCheckBox("student.passed");
  passed.addToPage(first, { x: 40, y: 220, width: 16, height: 16 });

  const grade = form.createDropdown("student.grade");
  grade.setOptions(["A", "B", "C"]);
  grade.addToPage(second, { x: 40, y: 340, width: 80, height: 20, font });

  const stream = form.createRadioGroup("student.stream");
  stream.addOptionToPage("Science", second, { x: 40, y: 300, width: 16, height: 16 });
  stream.addOptionToPage("Arts", second, { x: 80, y: 300, width: 16, height: 16 });

  const locked = form.createTextField("office.use");
  locked.setText("do not edit");
  locked.enableReadOnly();
  locked.addToPage(second, { x: 40, y: 260, width: 120, height: 20, font });

  return doc.save();
}

test("reads every field with its kind, options and page", async () => {
  const { fields, hasXfa } = await readForm(await makeForm());
  expect(hasXfa).toBe(false);

  const byName = new Map(fields.map((f) => [f.name, f]));
  expect([...byName.keys()].sort()).toEqual([
    "office.use",
    "student.grade",
    "student.name",
    "student.passed",
    "student.remarks",
    "student.stream",
  ]);
  expect(byName.get("student.name")!.kind).toBe("text");
  expect(byName.get("student.remarks")!.multiline).toBe(true);
  expect(byName.get("student.passed")!.kind).toBe("checkbox");
  expect(byName.get("student.grade")!.options).toEqual(["A", "B", "C"]);
  expect(byName.get("student.stream")!.options).toEqual(["Science", "Arts"]);
  // Fields know which page they sit on, so the UI can jump to one.
  expect(byName.get("student.name")!.pages).toEqual([0]);
  expect(byName.get("student.grade")!.pages).toEqual([1]);
  expect(byName.get("office.use")!.readOnly).toBe(true);
});

test("fills each kind and reads the values back", async () => {
  const filled = await fillForm(await makeForm(), {
    "student.name": "A. Student",
    "student.remarks": "Line one\nLine two",
    "student.passed": true,
    "student.grade": "B",
    "student.stream": "Arts",
  });

  const byName = new Map((await readForm(filled)).fields.map((f) => [f.name, f]));
  expect(byName.get("student.name")!.value).toBe("A. Student");
  expect(byName.get("student.remarks")!.value).toBe("Line one\nLine two");
  expect(byName.get("student.passed")!.value).toBe(true);
  // A dropdown can hold several selections, a radio group exactly one.
  expect(byName.get("student.grade")!.value).toEqual(["B"]);
  expect(byName.get("student.stream")!.value).toBe("Arts");
});

test("accepts the text a CSV would carry for a checkbox", async () => {
  // Batch filling from a spreadsheet (Phase 4) will not have booleans.
  for (const yes of ["yes", "TRUE", "on", "1", "x"]) {
    const filled = await fillForm(await makeForm(), { "student.passed": yes });
    const field = (await readForm(filled)).fields.find((f) => f.name === "student.passed");
    expect(field!.value, `"${yes}" should tick the box`).toBe(true);
  }
  const off = await fillForm(await makeForm(), { "student.passed": "no" });
  expect((await readForm(off)).fields.find((f) => f.name === "student.passed")!.value).toBe(false);
});

test("leaves a read-only field alone instead of failing", async () => {
  const filled = await fillForm(await makeForm(), { "office.use": "tampered" });
  const field = (await readForm(filled)).fields.find((f) => f.name === "office.use");
  expect(field!.value).toBe("do not edit");
});

test("rejects a name the document does not have", async () => {
  // Silently ignoring it would look like a form that refuses to save.
  await expect(fillForm(await makeForm(), { nonsense: "x" })).rejects.toThrow(/no field called/);
});

test("rejects an option a choice field does not offer", async () => {
  // pdf-lib would accept it, which in a batch fill means a typo silently writes
  // a value nobody reading the form expects.
  await expect(fillForm(await makeForm(), { "student.grade": "Z" })).rejects.toThrow(
    /not an option for "student.grade"/,
  );
  await expect(fillForm(await makeForm(), { "student.stream": "Commerce" })).rejects.toThrow(
    /not an option/,
  );
});

test("flattening keeps the values and removes the fields", async () => {
  const filled = await fillForm(
    await makeForm(),
    { "student.name": "A. Student", "student.passed": true },
    { flatten: true },
  );
  const after = await readForm(filled);
  expect(after.fields).toEqual([]);
  // The document still has its pages, with the values now drawn on them.
  expect((await PDFDocument.load(filled)).getPageCount()).toBe(2);
});

test("does not touch the caller's bytes", async () => {
  const original = await makeForm();
  const before = original.slice();
  await fillForm(original, { "student.name": "x" });
  expect(original).toEqual(before);
});
