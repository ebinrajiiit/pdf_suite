/**
 * Calculated and validated form fields, without running the document's own
 * code.
 *
 * Acrobat does this with JavaScript embedded in the PDF, which
 * `docs/PRODUCT.md` rules out: running a file's code on a machine holding
 * student records is a poor trade for a calculated total. So the arithmetic is
 * ours, over the field values, in a language small enough to read in one
 * sitting — numbers, the four operators, brackets, field names, and four
 * functions.
 *
 * The cost is that another reader will not recompute these. The formula is
 * stored in the document so this app can, and the UI says the total is written
 * into the field when the form is filled, which is what makes the saved file
 * correct everywhere.
 */

export type FormulaValues = Record<string, string | number | boolean | string[] | undefined>;

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaError";
  }
}

/** A number from whatever a field holds. Blank and unfillable read as zero. */
export function numberOf(value: FormulaValues[string]): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return numberOf(value[0]);
  if (typeof value !== "string") return 0;
  // Figures in a form arrive with commas and currency marks attached.
  const cleaned = value.replace(/[^0-9.+-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string };

function tokenise(formula: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;

  while (at < formula.length) {
    const character = formula[at]!;
    if (/\s/.test(character)) {
      at++;
      continue;
    }
    if (/[0-9.]/.test(character)) {
      const match = /^[0-9]*\.?[0-9]+/.exec(formula.slice(at));
      if (!match) throw new FormulaError(`that is not a number: ${formula.slice(at, at + 8)}`);
      tokens.push({ kind: "number", value: Number(match[0]) });
      at += match[0].length;
      continue;
    }
    // A field name: letters, digits, dots and underscores, as forms name them.
    if (/[A-Za-z_]/.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(formula.slice(at))!;
      tokens.push({ kind: "name", value: match[0] });
      at += match[0].length;
      continue;
    }
    if ("+-*/(),".includes(character)) {
      tokens.push({ kind: "op", value: character });
      at++;
      continue;
    }
    throw new FormulaError(`${character} has no meaning in a formula`);
  }

  return tokens;
}

const FUNCTIONS: Record<string, (values: number[]) => number> = {
  sum: (values) => values.reduce((total, value) => total + value, 0),
  avg: (values) => (values.length === 0 ? 0 : values.reduce((t, v) => t + v, 0) / values.length),
  min: (values) => (values.length === 0 ? 0 : Math.min(...values)),
  max: (values) => (values.length === 0 ? 0 : Math.max(...values)),
};

/**
 * Works out what a formula comes to.
 *
 * Recursive descent, which is the obvious way and the one anybody maintaining
 * this will recognise. Division by zero gives zero rather than Infinity: a
 * form showing ∞ in a fee column helps nobody.
 */
export function evaluate(formula: string, values: FormulaValues): number {
  const tokens = tokenise(formula.replace(/^=/, ""));
  let at = 0;

  const peek = () => tokens[at];
  const take = () => tokens[at++];

  const expression = (): number => {
    let left = term();
    for (;;) {
      const next = peek();
      if (next?.kind !== "op" || (next.value !== "+" && next.value !== "-")) return left;
      take();
      const right = term();
      left = next.value === "+" ? left + right : left - right;
    }
  };

  const term = (): number => {
    let left = factor();
    for (;;) {
      const next = peek();
      if (next?.kind !== "op" || (next.value !== "*" && next.value !== "/")) return left;
      take();
      const right = factor();
      left = next.value === "*" ? left * right : right === 0 ? 0 : left / right;
    }
  };

  const factor = (): number => {
    const token = take();
    if (!token) throw new FormulaError("the formula stops in the middle");

    if (token.kind === "number") return token.value;
    if (token.kind === "op" && token.value === "-") return -factor();
    if (token.kind === "op" && token.value === "(") {
      const inner = expression();
      const close = take();
      if (close?.kind !== "op" || close.value !== ")")
        throw new FormulaError("a bracket is unclosed");
      return inner;
    }
    if (token.kind === "name") {
      const next = peek();
      if (next?.kind === "op" && next.value === "(") {
        const fn = FUNCTIONS[token.value.toLowerCase()];
        if (!fn) throw new FormulaError(`there is no function called ${token.value}`);
        take();
        const args: number[] = [];
        if (!(peek()?.kind === "op" && peek()?.value === ")")) {
          for (;;) {
            args.push(expression());
            const separator = peek();
            if (separator?.kind === "op" && separator.value === ",") {
              take();
              continue;
            }
            break;
          }
        }
        const close = take();
        if (close?.kind !== "op" || close.value !== ")") {
          throw new FormulaError(`${token.value} has an unclosed bracket`);
        }
        return fn(args);
      }
      return numberOf(values[token.value]);
    }
    throw new FormulaError(`${token.value} cannot start a value`);
  };

  const result = expression();
  if (at < tokens.length) throw new FormulaError("there is something left over at the end");
  return Number.isFinite(result) ? result : 0;
}

/** The field names a formula reads, so the caller knows what to recompute on. */
export function dependencies(formula: string): string[] {
  const names = new Set<string>();
  for (const token of tokenise(formula.replace(/^=/, ""))) {
    if (token.kind === "name" && !(token.value.toLowerCase() in FUNCTIONS)) names.add(token.value);
  }
  return [...names];
}

export interface Rule {
  /** A formula, with or without a leading `=`. */
  formula?: string | undefined;
  /** The field cannot be left empty. */
  required?: boolean | undefined;
  /** Inclusive bounds for a number. */
  min?: number | undefined;
  max?: number | undefined;
}

/** What is wrong with a value, in words a person filling a form can act on. */
export function validate(
  name: string,
  value: FormulaValues[string],
  rule: Rule,
): string | undefined {
  const text = typeof value === "string" ? value.trim() : value;
  if (rule.required && (text === "" || text === undefined || text === false)) {
    return `${name} has to be filled in`;
  }
  if (text === "" || text === undefined) return undefined;

  if (rule.min !== undefined && numberOf(value) < rule.min) {
    return `${name} cannot be less than ${rule.min}`;
  }
  if (rule.max !== undefined && numberOf(value) > rule.max) {
    return `${name} cannot be more than ${rule.max}`;
  }
  return undefined;
}
