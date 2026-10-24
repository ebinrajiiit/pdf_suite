import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/**
 * A GitHub Pages project site is served from /<repo>/, not from the root.
 *
 * A root-relative runtime path — `src="/brand/mark.png"`, `new URL("/ocr/…")` —
 * asks the origin root there and gets a 404, while working perfectly in
 * development, in preview and in the desktop shell, where the base is "/". The
 * lockup vanishes and OCR stops, with nothing failing locally to say so.
 *
 * Vite rewrites such paths inside index.html, so this is only about the ones
 * built in code. `import.meta.env.BASE_URL` is the fix and already ends in "/".
 */
/**
 * Any string literal whose first segment is one of the directories this app
 * serves assets from. Matching the use sites instead — src=, new URL(, fetch(
 * — misses the common case, where the path is built into a variable first.
 */
const ROOT_RELATIVE = /["'`]\/(brand|ocr|assets)\//;

/** A path named in prose is not a path the app asks for. */
const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

test("no runtime asset path is root-relative", () => {
  const offences: string[] = [];
  for (const file of sources(new URL(".", import.meta.url).pathname)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!isComment(line) && ROOT_RELATIVE.test(line)) {
          offences.push(`${file.split("/src/")[1]}:${i + 1}  ${line.trim()}`);
        }
      });
  }
  expect(offences, "use `${import.meta.env.BASE_URL}…` instead of a leading /").toEqual([]);
});
