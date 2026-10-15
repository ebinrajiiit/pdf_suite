#!/usr/bin/env node
// Fails if any installed production dependency has a non-allow-listed licence
// or is on the banned-by-name list. Policy: docs/LICENSE-POLICY.md
import { execSync } from "node:child_process";

const ALLOWED = new Set([
  "MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "0BSD", "Zlib",
  "CC0-1.0", "Unlicense", "MPL-2.0", "BlueOak-1.0.0", "Python-2.0",
]);
const BANNED_NAMES = [/mupdf/i, /^pymupdf$/i, /^fitz$/i, /ghostscript/i, /pdf2docx/i];

// Accept simple SPDX expressions like "(MIT OR Apache-2.0)" if any alternative is allowed.
function isAllowed(licence) {
  if (!licence) return false;
  const parts = licence.replace(/[()]/g, "").split(/\s+OR\s+/i);
  return parts.some((p) => ALLOWED.has(p.trim()));
}

let report;
try {
  report = JSON.parse(execSync("pnpm licenses list --prod --json", { encoding: "utf8" }));
} catch (e) {
  console.error("Could not run `pnpm licenses list`. Run `pnpm install` first.");
  process.exit(2);
}

const failures = [];
for (const [licence, pkgs] of Object.entries(report)) {
  for (const pkg of pkgs) {
    if (BANNED_NAMES.some((re) => re.test(pkg.name))) {
      failures.push(`${pkg.name}: banned by name`);
    } else if (!isAllowed(licence)) {
      failures.push(`${pkg.name}: licence "${licence}" not allowed`);
    }
  }
}

if (failures.length) {
  console.error("Licence check failed:\n  " + failures.join("\n  "));
  console.error("\nSee docs/LICENSE-POLICY.md. A new licence category needs an ADR.");
  process.exit(1);
}
console.log("Licence check passed.");
