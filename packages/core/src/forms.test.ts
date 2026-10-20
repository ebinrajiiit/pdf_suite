import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { addField, fillForm, readForm, removeField, setFieldRule } from "./forms.js";
import { evaluate, validate } from "./formula.js";

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

describe("building a form", () => {
  async function blankPages(count = 2): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < count; i++) doc.addPage([400, 400]);
    return doc.save();
  }

  test("adds a text field that can then be filled", async () => {
    const withField = await addField(await blankPages(), {
      page: 0,
      name: "applicant.name",
      kind: "text",
      x: 50,
      y: 300,
      w: 200,
      h: 20,
    });

    const info = await readForm(withField);
    expect(info.fields.map((field) => field.name)).toEqual(["applicant.name"]);
    expect(info.fields[0]?.kind).toBe("text");
    expect(info.fields[0]?.pages).toEqual([0]);

    // And the field it built is one the filling path can write to.
    const filled = await fillForm(withField, { "applicant.name": "A Student" });
    expect((await readForm(filled)).fields[0]?.value).toBe("A Student");
  });

  test("adds checkboxes and dropdowns with their choices", async () => {
    let bytes = await addField(await blankPages(1), {
      page: 0,
      name: "agree",
      kind: "checkbox",
      x: 20,
      y: 100,
      w: 14,
      h: 14,
    });
    bytes = await addField(bytes, {
      page: 0,
      name: "course",
      kind: "dropdown",
      x: 20,
      y: 60,
      w: 150,
      h: 20,
      options: ["MTech", "PhD"],
    });

    const info = await readForm(bytes);
    expect(info.fields.map((field) => field.kind).sort()).toEqual(["checkbox", "dropdown"]);
    expect(info.fields.find((field) => field.name === "course")?.options).toEqual(["MTech", "PhD"]);

    const filled = await fillForm(bytes, { agree: true, course: ["PhD"] });
    const after = await readForm(filled);
    expect(after.fields.find((field) => field.name === "agree")?.value).toBe(true);
    expect(after.fields.find((field) => field.name === "course")?.value).toEqual(["PhD"]);
  });

  test("a name already in the document is refused, not quietly merged", async () => {
    const once = await addField(await blankPages(1), {
      page: 0,
      name: "roll",
      kind: "text",
      x: 10,
      y: 10,
      w: 100,
      h: 20,
    });
    await expect(
      addField(once, { page: 0, name: "roll", kind: "text", x: 10, y: 50, w: 100, h: 20 }),
    ).rejects.toThrow(/already has a field called roll/);
  });

  test("refuses a field with no name, no size, or on a page that is not there", async () => {
    const bytes = await blankPages(1);
    const box = { x: 10, y: 10, w: 100, h: 20 } as const;
    await expect(addField(bytes, { page: 0, name: " ", kind: "text", ...box })).rejects.toThrow(
      /needs a name/,
    );
    await expect(
      addField(bytes, { page: 0, name: "tiny", kind: "text", x: 1, y: 1, w: 2, h: 2 }),
    ).rejects.toThrow(/big enough to click/);
    await expect(addField(bytes, { page: 4, name: "far", kind: "text", ...box })).rejects.toThrow(
      /outside a 1-page document/,
    );
  });

  test("removes a field and leaves the others", async () => {
    let bytes = await addField(await blankPages(1), {
      page: 0,
      name: "one",
      kind: "text",
      x: 10,
      y: 10,
      w: 80,
      h: 20,
    });
    bytes = await addField(bytes, {
      page: 0,
      name: "two",
      kind: "text",
      x: 10,
      y: 50,
      w: 80,
      h: 20,
    });

    const after = await removeField(bytes, "one");
    expect((await readForm(after)).fields.map((field) => field.name)).toEqual(["two"]);
    await expect(removeField(after, "one")).rejects.toThrow(/no field called one/);
  });
});

describe("calculations stored on fields", () => {
  async function feeForm(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    let bytes = await doc.save();
    for (const name of ["fee.tuition", "fee.hostel", "fee.total"]) {
      bytes = await addField(bytes, {
        page: 0,
        name,
        kind: "text",
        x: 20,
        y: 300 - 30 * ["fee.tuition", "fee.hostel", "fee.total"].indexOf(name),
        w: 120,
        h: 20,
      });
    }
    return bytes;
  }

  test("a rule is stored with the field and read back with the form", async () => {
    const bytes = await setFieldRule(await feeForm(), "fee.total", {
      formula: "=sum(fee.tuition, fee.hostel)",
    });
    const info = await readForm(bytes);
    expect(info.rules["fee.total"]?.formula).toBe("=sum(fee.tuition, fee.hostel)");
    // Fields without a rule do not acquire an empty one.
    expect(info.rules["fee.tuition"]).toBeUndefined();
  });

  test("the formula and the filled values give the total a reader will see", async () => {
    const bytes = await setFieldRule(await feeForm(), "fee.total", {
      formula: "sum(fee.tuition, fee.hostel)",
    });
    const info = await readForm(bytes);
    const values = { "fee.tuition": "45000", "fee.hostel": "28,000" };
    const total = evaluate(info.rules["fee.total"]!.formula!, values);
    expect(total).toBe(73000);

    // Written in, so a reader that cannot recompute still sees the right number.
    const filled = await fillForm(bytes, { ...values, "fee.total": String(total) });
    const after = await readForm(filled);
    expect(after.fields.find((field) => field.name === "fee.total")?.value).toBe("73000");
  });

  test("checks are stored too, and a rule can be cleared", async () => {
    let bytes = await setFieldRule(await feeForm(), "fee.tuition", {
      required: true,
      min: 0,
      max: 100000,
    });
    const rule = (await readForm(bytes)).rules["fee.tuition"]!;
    expect(rule.required).toBe(true);
    expect(rule.min).toBe(0);
    expect(rule.max).toBe(100000);
    expect(validate("Tuition", "120000", rule)).toContain("cannot be more than");

    bytes = await setFieldRule(bytes, "fee.tuition", null);
    expect((await readForm(bytes)).rules["fee.tuition"]).toBeUndefined();
  });

  test("a rule on a field that is not there is refused", async () => {
    await expect(setFieldRule(await feeForm(), "nothing.here", { required: true })).rejects.toThrow(
      /no field called/,
    );
  });
});
