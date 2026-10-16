import type { FormField, FormInfo } from "@pdf-suite/core";

export interface FormPanelProps {
  form: FormInfo;
  /** Edited values, keyed by field name; absent means unchanged. */
  values: Record<string, string | string[] | boolean>;
  onChange: (name: string, value: string | string[] | boolean) => void;
  /** Called with a source page index, to jump to the field. */
  onGo: (page: number) => void;
}

/**
 * Fills in an AcroForm from a side panel rather than by clicking the fields on
 * the page.
 *
 * ponytail: the panel is keyboard-navigable and needs no widget geometry, which
 * the page-overlay version would. Overlay the inputs on the page when a form is
 * complex enough that the panel loses the user — the widget rectangles are
 * already available from pdf-lib.
 */
export function FormPanel({ form, values, onChange, onGo }: FormPanelProps) {
  if (form.hasXfa && form.fields.length === 0) {
    return (
      <p className="form-empty" data-testid="form-xfa">
        This is an XFA form, which this app does not support. Ask for it as a normal PDF form.
      </p>
    );
  }
  if (form.fields.length === 0) {
    return (
      <p className="form-empty" data-testid="form-empty">
        This document has no form fields.
      </p>
    );
  }

  return (
    <div className="form-panel" data-testid="form-panel">
      {form.hasXfa ? (
        <p className="form-note">
          This form also has an XFA layer, which this app ignores; the fields below are the AcroForm
          ones.
        </p>
      ) : null}
      {form.fields.map((field) => (
        <Field
          key={field.name}
          field={field}
          value={values[field.name] ?? field.value}
          onChange={onChange}
          onGo={onGo}
        />
      ))}
    </div>
  );
}

function Field({
  field,
  value,
  onChange,
  onGo,
}: {
  field: FormField;
  value: string | string[] | boolean | undefined;
  onChange: (name: string, value: string | string[] | boolean) => void;
  onGo: (page: number) => void;
}) {
  const id = `field-${field.name}`;
  const page = field.pages[0];
  const label = (
    <span className="form-label-row">
      <label htmlFor={id}>
        {field.name}
        {field.required ? <span aria-label="required"> *</span> : null}
      </label>
      {page === undefined ? null : (
        <button
          type="button"
          className="form-go"
          onClick={() => onGo(page)}
          title={`Go to page ${page + 1}`}
        >
          p{page + 1}
        </button>
      )}
    </span>
  );

  if (field.kind === "signature" || field.kind === "button") {
    return (
      <div className="form-field">
        {label}
        <span className="form-unfillable">
          {field.kind === "signature" ? "signature field" : "button"}
        </span>
      </div>
    );
  }

  if (field.kind === "checkbox") {
    return (
      <div className="form-field form-field-inline">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={field.readOnly}
          data-testid={id}
          onChange={(event) => onChange(field.name, event.target.checked)}
        />
        {label}
      </div>
    );
  }

  if (field.kind === "radio" || field.kind === "dropdown" || field.kind === "optionlist") {
    // A radio group holds one choice; the list kinds come back as arrays.
    const selected = Array.isArray(value)
      ? (value[0] ?? "")
      : typeof value === "string"
        ? value
        : "";
    return (
      <div className="form-field">
        {label}
        <select
          id={id}
          value={selected}
          disabled={field.readOnly}
          data-testid={id}
          onChange={(event) => onChange(field.name, event.target.value)}
        >
          <option value="">— none —</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const text = typeof value === "string" ? value : "";
  return (
    <div className="form-field">
      {label}
      {field.multiline ? (
        <textarea
          id={id}
          value={text}
          rows={3}
          disabled={field.readOnly}
          data-testid={id}
          onChange={(event) => onChange(field.name, event.target.value)}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={text}
          disabled={field.readOnly}
          data-testid={id}
          onChange={(event) => onChange(field.name, event.target.value)}
        />
      )}
    </div>
  );
}
