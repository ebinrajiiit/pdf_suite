import { evaluate, validate, type FormField, type FormInfo } from "@pdf-suite/core";

export interface FormPanelProps {
  form: FormInfo;
  /** Edited values, keyed by field name; absent means unchanged. */
  values: Record<string, string | string[] | boolean>;
  onChange: (name: string, value: string | string[] | boolean) => void;
  /** Called with a source page index, to jump to the field. */
  onGo: (page: number) => void;
}

/**
 * What the calculated fields come to, and what is wrong with what is filled in.
 *
 * Calculations run here rather than in the document, because the document's
 * own way of doing this is JavaScript and `docs/PRODUCT.md` rules that out. The
 * totals are written into the fields when the form is filled, so the saved file
 * is right in any reader even though only this one recomputes.
 */
export function computed(
  form: FormInfo,
  values: Record<string, string | string[] | boolean>,
): { totals: Record<string, string>; problems: Record<string, string> } {
  const current: Record<string, string | string[] | boolean | undefined> = {};
  for (const field of form.fields) current[field.name] = field.value;
  Object.assign(current, values);

  const totals: Record<string, string> = {};
  const problems: Record<string, string> = {};

  for (const [name, rule] of Object.entries(form.rules ?? {})) {
    if (rule.formula) {
      try {
        const total = evaluate(rule.formula, current);
        // Whole numbers as whole numbers: a fee of 73000 should not read
        // 73000.00 because the formula happened to divide somewhere.
        totals[name] = Number.isInteger(total) ? String(total) : total.toFixed(2);
        current[name] = totals[name];
      } catch (error) {
        problems[name] = error instanceof Error ? error.message : String(error);
      }
    }
    const wrong = validate(name, current[name], rule);
    if (wrong) problems[name] = wrong;
  }

  return { totals, problems };
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
  const { totals, problems } = computed(form, values);
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
          value={totals[field.name] ?? values[field.name] ?? field.value}
          onChange={onChange}
          onGo={onGo}
          calculated={totals[field.name] !== undefined}
          {...(problems[field.name] ? { problem: problems[field.name] } : {})}
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
  calculated,
  problem,
}: {
  field: FormField;
  value: string | string[] | boolean | undefined;
  onChange: (name: string, value: string | string[] | boolean) => void;
  onGo: (page: number) => void;
  /** Worked out from other fields, so typing in it would be overwritten. */
  calculated?: boolean | undefined;
  problem?: string | undefined;
}) {
  const id = `field-${field.name}`;
  const page = field.pages[0];
  const label = (
    <span className="form-label-row">
      <label htmlFor={id}>
        {field.name}
        {field.required ? <span aria-label="required"> *</span> : null}
        {calculated ? (
          <span className="form-calculated" title="Worked out from the other fields">
            {" "}
            =
          </span>
        ) : null}
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
          // A calculated field is read-only here: typing in it would be
          // overwritten by the next recalculation, which is worse than not
          // letting someone type.
          readOnly={calculated === true}
          disabled={field.readOnly}
          data-testid={id}
          onChange={(event) => onChange(field.name, event.target.value)}
        />
      )}
      {problem ? (
        <p className="form-problem" data-testid={`problem-${field.name}`}>
          {problem}
        </p>
      ) : null}
    </div>
  );
}
