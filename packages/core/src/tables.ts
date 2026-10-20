/**
 * Finding tables in a page's text, for exporting them as a spreadsheet.
 *
 * A PDF has no tables. It has text at coordinates, and a table is a thing a
 * reader infers from the fact that the coordinates line up. So this looks for
 * exactly that: runs that share a baseline are a row, and columns are the
 * gaps that every row agrees on.
 *
 * It finds grid tables — a mark sheet, a fee table, a result list — and that is
 * what it claims. It does not find merged cells, nested tables, or tables whose
 * columns are only implied by a change of font, and the export says so rather
 * than producing a spreadsheet that looks right and is not.
 */

export interface TextRunLike {
  text: string;
  /** PDF points, origin at the page's bottom-left. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Table {
  /** Rows of cells, each row the same length. */
  rows: string[][];
  /** How confident the shape is: the share of rows that filled every column. */
  confidence: number;
}

export interface TableOptions {
  /** A gap this many times the text height starts a new column. */
  columnGap?: number;
  /** Fewer rows or columns than this is not a table. */
  minimumRows?: number;
  minimumColumns?: number;
}

/** Groups runs into lines by their baselines. */
export function lines(runs: TextRunLike[]): TextRunLike[][] {
  const ordered = [...runs]
    .filter((run) => run.text.trim() !== "")
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const out: TextRunLike[][] = [];
  for (const run of ordered) {
    const current = out[out.length - 1];
    const last = current?.[0];
    // Same line when the baselines are within half the text's height: a
    // superscript sits a little above its line and still belongs to it.
    if (current && last && Math.abs(last.y - run.y) <= Math.max(last.h, run.h) * 0.5) {
      current.push(run);
    } else {
      out.push([run]);
    }
  }
  return out.map((line) => [...line].sort((a, b) => a.x - b.x));
}

/**
 * The table on a page, if the text makes one.
 *
 * Columns come from the left edges every row agrees on, not from one row's
 * shape: a heading that spans two columns would otherwise decide the layout
 * for the whole table.
 */
export function tableFrom(runs: TextRunLike[], options: TableOptions = {}): Table | undefined {
  const gap = options.columnGap ?? 1.2;
  const minimumRows = options.minimumRows ?? 2;
  const minimumColumns = options.minimumColumns ?? 2;

  const rows = lines(runs).filter((line) => line.length > 0);
  if (rows.length < minimumRows) return undefined;

  // Every run's left edge, clustered: edges within a character's width of each
  // other are the same column.
  const height = median(rows.flat().map((run) => run.h)) || 10;
  const edges = [...rows.flat().map((run) => run.x)].sort((a, b) => a - b);
  const columns: number[] = [];
  for (const edge of edges) {
    const last = columns[columns.length - 1];
    if (last === undefined || edge - last > height * gap) columns.push(edge);
  }
  if (columns.length < minimumColumns) return undefined;

  const grid = rows.map((line) => {
    const cells = new Array<string>(columns.length).fill("");
    for (const run of line) {
      // The last column that starts at or before this run.
      let at = 0;
      for (let i = 0; i < columns.length; i++) {
        if (run.x >= columns[i]! - height * 0.5) at = i;
      }
      cells[at] = cells[at] ? `${cells[at]} ${run.text.trim()}` : run.text.trim();
    }
    return cells;
  });

  const full = grid.filter((row) => row.every((cell) => cell !== "")).length;
  return { rows: grid, confidence: grid.length === 0 ? 0 : full / grid.length };
}

/** CSV, with the quoting a spreadsheet needs to read it back. */
export function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","),
    )
    .join("\n");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}
