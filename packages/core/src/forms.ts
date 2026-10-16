import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  type PDFField,
} from "pdf-lib";
import type { PdfBytes } from "./ops.js";

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

  return { fields, hasXfa: form.hasXFA() };
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
