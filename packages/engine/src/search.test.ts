import { expect, test } from "vitest";
import { findMatches } from "./search.js";
import type { TextRun } from "./types.js";

const run = (text: string, y = 0): TextRun => ({ text, x: 10, y, w: 100, h: 12 });

test("finds every occurrence and reports where each one is", () => {
  const runs = [run("the quick brown fox", 700), run("the lazy dog", 680)];
  const matches = findMatches(runs, "the");
  expect(matches).toHaveLength(2);
  expect(matches.map((m) => m.run)).toEqual([0, 1]);
  expect(matches[0]!.rects).toEqual([{ x: 10, y: 700, w: 100, h: 12 }]);
});

test("counts repeated occurrences within one run", () => {
  // Twice: "black" is b-l-a, not b-a.
  expect(findMatches([run("ba ba black sheep")], "ba")).toHaveLength(2);
  // Overlapping occurrences each count.
  expect(findMatches([run("aaa")], "aa")).toHaveLength(2);
});

test("ignores case", () => {
  expect(findMatches([run("Result Sheet")], "result sheet")).toHaveLength(1);
  expect(findMatches([run("result sheet")], "RESULT")).toHaveLength(1);
});

test("an empty or blank query matches nothing", () => {
  expect(findMatches([run("anything")], "")).toEqual([]);
  expect(findMatches([run("anything")], "   ")).toEqual([]);
});

test("no match is an empty list, not a zero-rect match", () => {
  expect(findMatches([run("the quick brown fox")], "cat")).toEqual([]);
});

// Indic text is first-class (CLAUDE.md §4). Extracted text and a typed query can
// differ in Unicode normalisation while being the same word to a reader, which is
// the failure a Latin-only test would never catch. These fixtures are written as
// escapes so that no editor can quietly normalise them.
test("matches Malayalam whether the vowel sign is composed or decomposed", () => {
  // "കൊച്ചി" (Kochi): the vowel sign O is one code point composed (U+0D4A) and
  // two decomposed (U+0D46 U+0D3E).
  const composed = "കൊച്ചി";
  const decomposed = "കൊച്ചി";
  expect(composed).not.toBe(decomposed); // the test proves nothing otherwise

  expect(findMatches([run(composed)], decomposed)).toHaveLength(1);
  expect(findMatches([run(decomposed)], composed)).toHaveLength(1);
});

test("matches Hindi across the precomposed nukta forms", () => {
  // "क़िताब": U+0958 is a precomposed QA, which Unicode excludes from
  // composition, so it only ever matches KA + nukta after folding.
  const legacy = "क़िताब";
  const nukta = "क़िताब";
  expect(legacy).not.toBe(nukta);

  expect(findMatches([run(legacy)], nukta)).toHaveLength(1);
  expect(findMatches([run(nukta)], legacy)).toHaveLength(1);
});

test("finds a Malayalam word inside a longer line", () => {
  // "വിദ്യാർഥിയുടെ പേര്: കോഴിക്കോട്" — a line as it might appear on a grade card.
  const line = run("വിദ്യാർഥിയുടെ " + "കോഴിക്കോട്");
  expect(findMatches([line], "കോഴിക്കോട്")).toHaveLength(1);
  // A word that is not there must not match through over-eager folding.
  expect(findMatches([line], "ഇല്ല")).toEqual([]);
});

// Both of these come from the OCR spike (ADR 0004): Tesseract returned the ZWJ
// spelling of a word whose atomic spelling is what a user types. Neither NFC nor
// NFKC reconciles the two, so matching has to.
test("matches Malayalam chillu letters in either spelling", () => {
  const atomic = "സർവകലാശാല"; // ...U+0D7C...
  const withZwj = "സര്‍വകലാശാല"; // ...U+0D30 U+0D4D U+200D...
  expect(atomic).not.toBe(withZwj);
  expect(atomic.normalize("NFKC")).not.toBe(withZwj.normalize("NFKC"));

  expect(findMatches([run(withZwj)], atomic)).toHaveLength(1);
  expect(findMatches([run(atomic)], withZwj)).toHaveLength(1);
});

test("matches every chillu letter in either spelling", () => {
  const pairs: [string, string][] = [
    ["ൺ", "ണ്‍"],
    ["ൻ", "ന്‍"],
    ["ർ", "ര്‍"],
    ["ൽ", "ല്‍"],
    ["ൾ", "ള്‍"],
    ["ൿ", "ക്‍"],
  ];
  for (const [atomic, withZwj] of pairs) {
    expect(findMatches([run(`വാ${withZwj}ക`)], `വാ${atomic}ക`)).toHaveLength(1);
  }
});

test("a zero-width joiner in the query does not stop a match", () => {
  expect(findMatches([run("പരീക്ഷാ")], "പരീ‍ക്ഷാ")).toHaveLength(1);
});
