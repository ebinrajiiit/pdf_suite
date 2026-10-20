import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  type PDFField,
} from "pdf-lib";
import type { PdfBytes } from "./ops.js";
import type { Rule } from "./formula.js";

/**
 * AcroForm reading and filling. XFA forms are explicitly out of scope
 * (`docs/PRODUCT.md` non-goals); a document that has only XFA is reported as
 * such rather than silently showing no fields.
 */

export type FieldKind =
  "text" | "checkbox" | "radio" | "dropdown" | "optionlist" | "signature" | "button";

export interface FormField {
  /** Fully qualified field name, which is what a value is addressed by. */
  name: string;
  kind: FieldKind;
  /**
   * Text for a text field, a boolean for a checkbox, the chosen option for a
   * radio group, and a list for a dropdown or option list — which can hold more
   * than one selection.
   */
  value: string | string[] | boolean | undefined;
  /** Choices for radio groups, dropdowns and option lists. */
  options?: string[];
  readOnly: boolean;
  required: boolean;
  multiline?: boolean;
  /** Source page indices this field appears on. */
  pages: number[];
}

export interface FormInfo {
  fields: FormField[];
  /** True when the document carries an XFA form, which we do not support. */
  hasXfa: boolean;
  /** Calculations and checks this app has stored on fields, by field name. */
  rules: Record<string, Rule>;
}

/** A value to write, keyed by field name. */
export type FieldValues = Record<string, string | string[] | boolean>;

function kindOf(field: PDFField): FieldKind {
  if (field instanceof PDFTextField) return "text";
  if (field instanceof PDFCheckBox) return "checkbox";
  if (field instanceof PDFRadioGroup) return "radio";
  if (field instanceof PDFDropdown) return "dropdown";
  if (field instanceof PDFOptionList) return "optionlist";
  if (field instanceof PDFSignature) return "signature";
  return "button";
}

export async function readForm(input: PdfBytes): Promise<FormInfo> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const form = doc.getForm();

  // Widget references are how a field is tied to a page; the field itself does
  // not know, so build the reverse index once.
  const pageOfWidget = new Map<string, number>();
  doc.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (ref) pageOfWidget.set(ref.toString(), index);
    }
  });

  const fields: FormField[] = [];
  for (const field of form.getFields()) {
    const kind = kindOf(field);
    const pages = new Set<number>();
    for (const widget of field.acroField.getWidgets()) {
      const ref = doc.context.getObjectRef(widget.dict);
      const page = ref ? pageOfWidget.get(ref.toString()) : undefined;
      if (page !== undefined) pages.add(page);
    }

    const common = {
      name: field.getName(),
      kind,
      readOnly: field.isReadOnly(),
      required: field.isRequired(),
      pages: [...pages].sort((a, b) => a - b),
    };

    if (field instanceof PDFTextField) {
      fields.push({
        ...common,
        value: field.getText(),
        multiline: field.isMultiline(),
      });
    } else if (field instanceof PDFCheckBox) {
      fields.push({ ...common, value: field.isChecked() });
    } else if (field instanceof PDFRadioGroup) {
      // A radio group has one selection, so pdf-lib gives a string here and an
      // array for the list kinds. Keeping that difference is more useful to a UI
      // than flattening both into one shape.
      fields.push({ ...common, value: field.getSelected(), options: field.getOptions() });
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      fields.push({ ...common, value: field.getSelected(), options: field.getOptions() });
    } else {
      // Signature and push-button fields have no value to fill in.
      fields.push({ ...common, value: undefined });
    }
  }

  return { fields, hasXfa: form.hasXFA(), rules: rulesOf(doc) };
}

/**
 * The calculations and checks this app has stored on fields.
 *
 * They live under a private key in the field dictionary. Another reader will
 * ignore them — Acrobat computes with document JavaScript, which
 * `docs/PRODUCT.md` rules out — so the values they produce are written into the
 * fields when the form is filled. That way the saved file is right everywhere,
 * even though only this app recomputes.
 */
const RULE_KEY = "PDFSuiteRule";

function rulesOf(doc: PDFDocument): Record<string, Rule> {
  const rules: Record<string, Rule> = {};
  for (const field of doc.getForm().getFields()) {
    const stored = field.acroField.dict.lookup(PDFName.of(RULE_KEY));
    if (!(stored instanceof PDFDict)) continue;

    const formula = stored.lookup(PDFName.of("F"));
    const min = stored.lookup(PDFName.of("Min"));
    const max = stored.lookup(PDFName.of("Max"));
    rules[field.getName()] = {
      ...(formula instanceof PDFString || formula instanceof PDFHexString
        ? { formula: formula.decodeText() }
        : {}),
      ...(stored.get(PDFName.of("Req")) !== undefined
        ? { required: String(stored.get(PDFName.of("Req"))) === "true" }
        : {}),
      ...(min instanceof PDFNumber ? { min: min.asNumber() } : {}),
      ...(max instanceof PDFNumber ? { max: max.asNumber() } : {}),
    };
  }
  return rules;
}

/** Stores a calculation or a check on a field, or clears it. */
export async function setFieldRule(
  input: PdfBytes,
  name: string,
  rule: Rule | null,
): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const field = doc
    .getForm()
    .getFields()
    .find((one) => one.getName() === name);
  if (!field) throw new Error(`no field called ${name}`);

  if (rule === null) {
    field.acroField.dict.delete(PDFName.of(RULE_KEY));
    return doc.save();
  }

  field.acroField.dict.set(
    PDFName.of(RULE_KEY),
    doc.context.obj({
      ...(rule.formula ? { F: PDFString.of(rule.formula) } : {}),
      ...(rule.required !== undefined ? { Req: rule.required } : {}),
      ...(rule.min !== undefined ? { Min: rule.min } : {}),
      ...(rule.max !== undefined ? { Max: rule.max } : {}),
    }),
  );
  return doc.save();
}

export interface FillOptions {
  /**
   * Bake the values into the page content and remove the fields, so the result
   * cannot be edited. What a filled form is usually for once it is final.
   */
  flatten?: boolean;
}

/**
 * pdf-lib will happily select an option a field does not offer, which for a
 * batch fill from a spreadsheet (Phase 4) means a typo writes a value no reader
 * of the form expects. Checking it here turns that into an error.
 */
function check(name: string, choice: string, options: string[]): string {
  if (options.includes(choice)) return choice;
  throw new Error(
    `"${choice}" is not an option for "${name}" (it offers ${options.map((o) => `"${o}"`).join(", ")})`,
  );
}

/**
 * Writes the given values and returns new bytes. Unknown names are an error
 * rather than a silent no-op: a typo in a field name would otherwise look like a
 * form that refuses to save.
 */
export async function fillForm(
  input: PdfBytes,
  values: FieldValues,
  options: FillOptions = {},
): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const form = doc.getForm();

  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) throw new Error(`this document has no field called "${name}"`);
    if (field.isReadOnly()) continue;

    if (field instanceof PDFTextField) {
      field.setText(value === false ? "" : String(value));
    } else if (field instanceof PDFCheckBox) {
      // A checkbox arrives as a boolean from a UI, or as text from a CSV.
      const on = typeof value === "boolean" ? value : /^(true|yes|on|1|x)$/i.test(String(value));
      if (on) field.check();
      else field.uncheck();
    } else if (field instanceof PDFRadioGroup || field instanceof PDFDropdown) {
      const choice = Array.isArray(value) ? value[0] : String(value);
      if (choice === undefined || choice === "") field.clear();
      else field.select(check(name, choice, field.getOptions()));
    } else if (field instanceof PDFOptionList) {
      const choices = Array.isArray(value) ? value : [String(value)];
      field.clear();
      for (const choice of choices) {
        if (choice !== "") field.select(check(name, choice, field.getOptions()), false);
      }
    } else {
      throw new Error(`"${name}" is a ${kindOf(field)} field and cannot be filled in`);
    }
  }

  if (options.flatten) form.flatten();
  return doc.save();
}

/** What a new field needs: where it goes, what it is called, and what it is. */
export interface NewField {
  /** Source page index. */
  page: number;
  /** Fully qualified name. Two fields with one name share a value, which is
   *  how a form repeats an answer across pages — and how one gets overwritten
   *  by accident, so a clash is refused rather than silently merged. */
  name: string;
  kind: "text" | "checkbox" | "dropdown";
  /** Box in PDF points, origin at the page's bottom-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** For a dropdown. */
  options?: string[] | undefined;
  multiline?: boolean | undefined;
  required?: boolean | undefined;
}

/**
 * Adds a field to the document — Acrobat's "Prepare Form", one field at a time.
 *
 * Tab order follows the order fields are created, which is what the PDF
 * specification calls the document's own order and what a reader uses when the
 * page has no explicit `/Tabs`. Dragging a field into a different place does
 * not change it, which is worth knowing when building a two-column form.
 */
export async function addField(input: PdfBytes, field: NewField): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const count = doc.getPageCount();
  if (!Number.isInteger(field.page) || field.page < 0 || field.page >= count) {
    throw new RangeError(`field page ${field.page} outside a ${count}-page document`);
  }
  if (field.name.trim() === "") throw new Error("a field needs a name");
  if (field.w < 4 || field.h < 4) throw new Error("a field has to be big enough to click");

  const form = doc.getForm();
  if (form.getFields().some((existing) => existing.getName() === field.name)) {
    throw new Error(`this document already has a field called ${field.name}`);
  }

  const page = doc.getPage(field.page);
  const where = { x: field.x, y: field.y, width: field.w, height: field.h };

  if (field.kind === "text") {
    const made = form.createTextField(field.name);
    if (field.multiline) made.enableMultiline();
    if (field.required) made.enableRequired();
    made.addToPage(page, where);
  } else if (field.kind === "checkbox") {
    const made = form.createCheckBox(field.name);
    if (field.required) made.enableRequired();
    made.addToPage(page, where);
  } else {
    const made = form.createDropdown(field.name);
    made.setOptions(field.options ?? []);
    if (field.required) made.enableRequired();
    made.addToPage(page, where);
  }

  return doc.save();
}

/** Removes a field and the widgets that show it. */
export async function removeField(input: PdfBytes, name: string): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const form = doc.getForm();
  const field = form.getFields().find((one) => one.getName() === name);
  if (!field) throw new Error(`no field called ${name}`);
  form.removeField(field);
  return doc.save();
}
