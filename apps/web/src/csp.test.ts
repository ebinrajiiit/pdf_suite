import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// The CSP is a privacy invariant (CLAUDE.md §1.5), so the shipped header and the
// documented one must not drift apart. Both sides of this assertion are sources
// of truth; if they disagree, one of them is a bug.
test("index.html CSP matches docs/PRIVACY.md exactly", () => {
  const documented = /\*\*CSP:\*\*\s*`([^`]+)`/.exec(read("../../../docs/PRIVACY.md"))?.[1];
  const shipped = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
    read("../index.html"),
  )?.[1];

  expect(documented, "no CSP found in docs/PRIVACY.md").toBeTruthy();
  expect(shipped, "no CSP meta tag found in index.html").toBe(documented);
});

test("CSP keeps connect-src 'self'", () => {
  expect(read("../index.html")).toContain("connect-src 'self'");
});
