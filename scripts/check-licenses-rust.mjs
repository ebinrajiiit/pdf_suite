#!/usr/bin/env node
// Licence check for the Rust crates compiled into the desktop app.
//
// `pnpm check:licenses` reads npm metadata and `scripts/third-party.json`, and
// neither knows anything about Cargo. A Tauri build links several hundred
// crates, all of which ship inside the binary we hand to a customer, so they
// need the same allow-list as everything else (docs/LICENSE-POLICY.md).
//
// Needs a Rust toolchain. Without one it says so and exits 0, because the web
// app's CI has no business installing Rust — the desktop CI job runs this.
//
//   node scripts/check-licenses-rust.mjs [--json]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const manifest = join(repoRoot, "apps/desktop/src-tauri/Cargo.toml");

if (!existsSync(manifest)) {
  console.log("No desktop app; nothing to check.");
  process.exit(0);
}

const ALLOWED = new Set(
  JSON.parse(readFileSync(new URL("./allowed-licences.json", import.meta.url), "utf8")).allowed,
);

/**
 * SPDX with AND and OR, plus Cargo's older `MIT/Apache-2.0` slash form, which
 * means the same as OR. AND needs every term allowed; OR needs one.
 */
function isAllowed(expression) {
  if (!expression) return false;
  return expression
    .replace(/[()]/g, "")
    .split(/\s+OR\s+|\//i)
    .some((alternative) =>
      alternative
        .split(/\s+AND\s+/i)
        .every((term) => ALLOWED.has(term.trim().replace(/\s+WITH\s+.*$/i, ""))),
    );
}

let metadata;
try {
  metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--manifest-path", manifest, "--locked"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT|not found/i.test(message)) {
    console.log("No Rust toolchain here; skipping the crate licence check.");
    console.log("It runs in the desktop CI job, which installs one.");
    process.exit(0);
  }
  console.error(`cargo metadata failed: ${message.split("\n")[0]}`);
  process.exit(2);
}

// Only what actually ships: the crates reachable from our package, not dev
// dependencies of dependencies.
const packages = metadata.packages.filter((p) => p.name !== "pdf-suite");
const failures = [];
const byLicence = new Map();

for (const pkg of packages) {
  const licence = pkg.license ?? (pkg.license_file ? `file: ${pkg.license_file}` : undefined);
  byLicence.set(licence ?? "none declared", (byLicence.get(licence ?? "none declared") ?? 0) + 1);
  if (!isAllowed(licence)) {
    failures.push(`${pkg.name} ${pkg.version}: ${licence ?? "no licence declared"}`);
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ crates: packages.length, licences: [...byLicence] }, null, 2));
} else {
  console.log(`${packages.length} crates in the desktop dependency graph:\n`);
  for (const [licence, count] of [...byLicence].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${licence}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} crate(s) with a licence that is not allow-listed:\n`);
  // Group identical licences so the output is a decision list, not a wall.
  const grouped = new Map();
  for (const failure of failures) {
    const licence = failure.slice(failure.indexOf(": ") + 2);
    grouped.set(licence, [...(grouped.get(licence) ?? []), failure.split(":")[0]]);
  }
  for (const [licence, crates] of grouped) {
    console.error(`  ${licence}`);
    console.error(`    ${crates.slice(0, 8).join(", ")}${crates.length > 8 ? ", …" : ""}`);
  }
  console.error("\nEach distinct licence here needs an ADR before a desktop release.");
  console.error("See docs/LICENSE-POLICY.md.");
  process.exit(1);
}
console.log("\nEvery crate licence is allow-listed.");
