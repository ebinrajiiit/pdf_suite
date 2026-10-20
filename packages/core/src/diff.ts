/**
 * Comparing two versions of a document — Acrobat's Compare Files, for text.
 *
 * An institution's real question is "what changed in the revised circular?",
 * and the answer has to be a list someone can read, not two documents side by
 * side to squint at. This diffs the words of each page and reports what went
 * and what arrived.
 *
 * Pages are paired by position. Acrobat tries to match pages that moved; this
 * does not, and says so, because a wrong guess about which page corresponds to
 * which produces a diff that is confidently about the wrong text.
 */

export interface PageDiff {
  /** Display position, the same in both documents. */
  page: number;
  /** Runs of words only in the newer document. */
  added: string[];
  /** Runs of words only in the older one. */
  removed: string[];
  /** True when nothing changed on this page. */
  same: boolean;
}

export interface DocumentDiff {
  pages: PageDiff[];
  /** Positions the open document has and the other one does not. */
  onlyHere: number[];
  /** Positions the other document has and the open one does not. */
  onlyThere: number[];
  changed: number;
}

/** Words, with the punctuation attached, which is how a reader compares text. */
function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== "");
}

/**
 * The longest common subsequence of two word lists, as a diff.
 *
 * O(n·m) in time and memory, which is fine for a page and not for a book: the
 * caller works a page at a time, and a page of 1,000 words costs a million
 * cells. Beyond that the page is reported as wholly changed rather than
 * spending a second on it.
 */
export function diffWords(
  before: string[],
  after: string[],
): { added: string[]; removed: string[] } {
  if (before.length * after.length > 4_000_000) {
    return {
      added: after.length > 0 ? [after.join(" ")] : [],
      removed: before.length > 0 ? [before.join(" ")] : [],
    };
  }

  // table[i][j] = length of the LCS of before[i..] and after[j..]
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i]![j] =
        before[i] === after[j]
          ? (table[i + 1]![j + 1] ?? 0) + 1
          : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
    }
  }

  const added: string[] = [];
  const removed: string[] = [];
  let run: { kind: "added" | "removed"; words: string[] } | undefined;
  const flush = () => {
    if (!run) return;
    (run.kind === "added" ? added : removed).push(run.words.join(" "));
    run = undefined;
  };

  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flush();
      i++;
      j++;
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      if (run?.kind !== "removed") flush();
      run = { kind: "removed", words: [...(run?.words ?? []), before[i]!] };
      i++;
    } else {
      if (run?.kind !== "added") flush();
      run = { kind: "added", words: [...(run?.words ?? []), after[j]!] };
      j++;
    }
  }
  while (i < before.length) {
    if (run?.kind !== "removed") flush();
    run = { kind: "removed", words: [...(run?.words ?? []), before[i]!] };
    i++;
  }
  while (j < after.length) {
    if (run?.kind !== "added") flush();
    run = { kind: "added", words: [...(run?.words ?? []), after[j]!] };
    j++;
  }
  flush();

  return { added, removed };
}

/**
 * Compares two documents page by page, as lists of page text. `theirs` is the
 * document being compared against — the older version, usually — and `ours` is
 * the one open, so "added" means added here.
 */
export function diffDocuments(theirs: string[], ours: string[]): DocumentDiff {
  const pages: PageDiff[] = [];
  let changed = 0;

  for (let page = 0; page < Math.min(theirs.length, ours.length); page++) {
    const { added, removed } = diffWords(words(theirs[page] ?? ""), words(ours[page] ?? ""));
    const same = added.length === 0 && removed.length === 0;
    if (!same) changed++;
    pages.push({ page, added, removed, same });
  }

  return {
    pages,
    onlyHere: range(theirs.length, ours.length),
    onlyThere: range(ours.length, theirs.length),
    changed,
  };
}

/** Positions `from` up to `to`, which is empty when the first is the larger. */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}
