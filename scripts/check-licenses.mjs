#!/usr/bin/env node
// Fails if any installed production dependency has a non-allow-listed licence
// or is on the banned-by-name list. Policy: docs/LICENSE-POLICY.md
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWED = new Set(
  JSON.parse(readFileSync(new URL("./allowed-licences.json", import.meta.url), "utf8")).allowed,
);
const BANNED_NAMES = [/mupdf/i, /^pymupdf$/i, /^fitz$/i, /ghostscript/i, /pdf2docx/i];

// Evaluate simple SPDX expressions. AND binds tighter than OR, so "(MIT AND
// Zlib) OR GPL-2.0" is allowed via its first operand: a choice needs one allowed
// alternative, a conjunction needs every term allowed because all of them apply.
function isAllowed(licence) {
  if (!licence) return false;
  return licence
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/i)
    .some((alternative) =>
      alternative.split(/\s+AND\s+/i).every((term) => ALLOWED.has(term.trim())),
    );
}

let report;
try {
  report = JSON.parse(execSync("pnpm licenses list --prod --json", { encoding: "utf8" }));
} catch {
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

// npm metadata says nothing about code compiled into a wasm blob, so the
// components recorded in third-party.json are checked against the same list.
// Nothing enforced this before qpdf arrived carrying libjpeg-turbo.
const thirdParty = JSON.parse(readFileSync(new URL("./third-party.json", import.meta.url), "utf8"));
for (const component of thirdParty.components) {
  if (!isAllowed(component.licence)) {
    failures.push(
      `${component.name} (third-party.json): licence "${component.licence}" not allowed`,
    );
  }
}

if (failures.length) {
  console.error("Licence check failed:\n  " + failures.join("\n  "));
  console.error("\nSee docs/LICENSE-POLICY.md. A new licence category needs an ADR.");
  process.exit(1);
}
console.log("Licence check passed.");
