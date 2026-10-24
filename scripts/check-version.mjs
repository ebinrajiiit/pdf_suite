#!/usr/bin/env node
// The version lives in five manifests that nothing links together. A release
// tag names one of them, so a tag that disagrees with the build publishes a
// version that was never built.
//
//   node scripts/check-version.mjs          # they all agree
//   node scripts/check-version.mjs 0.1.0    # ...and they agree with this
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const json = (p) => JSON.parse(read(p));

const found = [
  ["package.json", json("package.json").version],
  ["apps/web/package.json", json("apps/web/package.json").version],
  ["apps/desktop/package.json", json("apps/desktop/package.json").version],
  [
    "apps/desktop/src-tauri/tauri.conf.json",
    json("apps/desktop/src-tauri/tauri.conf.json").version,
  ],
  // Not TOML-parsed: the version is the first `version =` under [package], and a
  // dependency on a TOML parser to read one line is not worth it.
  [
    "apps/desktop/src-tauri/Cargo.toml",
    /^version\s*=\s*"([^"]+)"/m.exec(read("apps/desktop/src-tauri/Cargo.toml"))?.[1],
  ],
  // The lock carries it too, and CI builds with --locked, so a bumped
  // Cargo.toml and a stale lock fails every desktop job on every platform.
  [
    "apps/desktop/src-tauri/Cargo.lock",
    /name = "pdf-suite"\nversion = "([^"]+)"/.exec(read("apps/desktop/src-tauri/Cargo.lock"))?.[1],
  ],
];

const missing = found.filter(([, v]) => !v);
if (missing.length > 0) {
  for (const [where] of missing) console.error(`no version found in ${where}`);
  process.exit(1);
}

const expected = process.argv[2]?.replace(/^v/, "") ?? found[0][1];
const wrong = found.filter(([, v]) => v !== expected);

if (wrong.length > 0) {
  console.error(`Version disagreement. Expected ${expected}:`);
  for (const [where, v] of found) {
    console.error(`  ${v === expected ? " " : "✗"} ${v.padEnd(10)} ${where}`);
  }
  console.error("\nSet them all to one version, then tag that version.");
  process.exit(1);
}

console.log(`Version ${expected} in all ${found.length} manifests.`);
