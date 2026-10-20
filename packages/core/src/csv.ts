/**
 * Reading a spreadsheet export, for filling a form once per row.
 *
 * Grade cards, certificates, hall tickets, offer letters: an institution's
 * repetitive documents are one template and a list of people. Acrobat does
 * this with its Action Wizard; here it is a CSV and a form, which is what
 * every office already has.
 *
 * The parser is the awkward part of CSV rather than the obvious part: a field
 * can contain commas, newlines and quotes, and a parser that splits on commas
 * works right up until a name has a comma in it — which, in a list of people,
 * is the second week.
 */

export interface Sheet {
  /** Column names, from the first row. */
  columns: string[];
  /** One record per row, keyed by column name. */
  rows: Record<string, string>[];
}

/** Parses CSV, including quoted fields with commas and newlines in them. */
export function parseCsv(text: string): Sheet {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let at = 0;

  // A byte-order mark at the start of a spreadsheet export is normal and would
  // otherwise become part of the first column's name.
  const input = text.replace(/^\uFEFF/, "");

  while (at < input.length) {
    const character = input[at]!;

    if (quoted) {
      if (character === '"') {
        if (input[at + 1] === '"') {
          field += '"';
          at += 2;
          continue;
        }
        quoted = false;
        at++;
        continue;
      }
      field += character;
      at++;
      continue;
    }

    if (character === '"') {
      quoted = true;
      at++;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      at++;
      continue;
    }
    if (character === "\r") {
      at++;
      continue;
    }
    if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      at++;
      continue;
    }
    field += character;
    at++;
  }

  // Whatever is left is the last field of the last row, unless the file ended
  // with a newline and there is nothing left at all.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift() ?? [];
  const columns = header.map((name) => name.trim());
  return {
    columns,
    rows: rows
      // A trailing blank line is not a person.
      .filter((cells) => cells.some((cell) => cell.trim() !== ""))
      .map((cells) => {
        const record: Record<string, string> = {};
        columns.forEach((column, index) => {
          record[column] = (cells[index] ?? "").trim();
        });
        return record;
      }),
  };
}

/**
 * Which columns line up with which form fields.
 *
 * A column is matched to a field of the same name, ignoring case and the dots
 * and underscores people put in field names: a column called "Student Name"
 * fills `student.name`. Anything that does not match is reported rather than
 * dropped, because a column nobody noticed was ignored is how a hundred
 * certificates go out with a blank where the roll number should be.
 */
export function matchColumns(
  columns: string[],
  fields: string[],
): { pairs: Record<string, string>; unmatchedColumns: string[]; unfilledFields: string[] } {
  const flatten = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byField = new Map(fields.map((field) => [flatten(field), field]));
  const pairs: Record<string, string> = {};
  const unmatchedColumns: string[] = [];

  for (const column of columns) {
    const field = byField.get(flatten(column));
    if (field) pairs[column] = field;
    else unmatchedColumns.push(column);
  }

  const filled = new Set(Object.values(pairs));
  return {
    pairs,
    unmatchedColumns,
    unfilledFields: fields.filter((field) => !filled.has(field)),
  };
}

/** The values for one row, keyed by the field they fill. */
export function valuesFor(
  row: Record<string, string>,
  pairs: Record<string, string>,
): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const [column, field] of Object.entries(pairs)) {
    const cell = row[column] ?? "";
    // A tick box takes a yes rather than the word "yes".
    values[field] = /^(yes|true|y|1|✓)$/i.test(cell)
      ? true
      : /^(no|false|n|0)$/i.test(cell)
        ? false
        : cell;
  }
  return values;
}

/** A file name for one row, from a column that looks like a name or a roll. */
export function nameFor(row: Record<string, string>, index: number): string {
  const key = Object.keys(row).find((column) => /roll|name|id|number/i.test(column));
  const raw = key ? (row[key] ?? "") : "";
  const safe = raw.replace(/[^\w\s-]/g, "").trim();
  return safe === "" ? `row-${index + 1}` : safe;
}
