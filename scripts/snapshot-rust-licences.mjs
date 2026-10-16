#!/usr/bin/env node
// Records the licence of every crate compiled into the desktop binary, with the
// licence text each one ships, into scripts/rust-licences.json.
//
// Why a snapshot rather than reading Cargo at generation time: the notices file
// has to be generatable and checkable without a Rust toolchain, since the web CI
// job has none. This command needs cargo and runs in the desktop job; the
// generator and `pnpm check:notices` then read the snapshot.
//
// Texts are deduplicated by hash. Apache-2.0 alone is 11 kB and appears in
// hundreds of crates, so storing it per crate would make the file megabytes.
//
//   node scripts/snapshot-rust-licences.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const manifest = join(repoRoot, "apps/desktop/src-tauri/Cargo.toml");
const out = join(repoRoot, "scripts/rust-licences.json");

const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--manifest-path", manifest, "--locked"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ),
);

const LICENCE_FILE = /^(LICEN[CS]E|COPYING|NOTICE)/i;
const texts = new Map();
const crates = [];

for (const pkg of metadata.packages.sort((a, b) => a.name.localeCompare(b.name))) {
  if (pkg.name === "pdf-suite") continue;
  const dir = dirname(pkg.manifest_path);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => LICENCE_FILE.test(f)) : [];

  const hashes = [];
  for (const file of files.sort()) {
    const text = readFileSync(join(dir, file), "utf8").trim();
    // Some crates ship a licence "file" that is a one-line pointer; keep them
    // anyway, they are still what the crate chose to say.
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    if (!texts.has(hash)) texts.set(hash, text);
    hashes.push(hash);
  }

  crates.push({
    name: pkg.name,
    version: pkg.version,
    licence: pkg.license ?? null,
    repository: pkg.repository ?? null,
    texts: hashes,
  });
}

const snapshot = {
  $comment:
    "Licences of every Rust crate compiled into the desktop binary. Written by " +
    "scripts/snapshot-rust-licences.mjs, which needs cargo; read by " +
    "scripts/third-party-notices.mjs, which does not. Regenerate whenever " +
    "Cargo.lock changes — the desktop CI job checks it is current.",
  // No timestamp on purpose: the snapshot is a pure function of Cargo.lock, so
  // regenerating it produces an identical file and CI can diff it to prove it is
  // current. A generatedAt would make that check fail on every run.
  crates,
  // Keyed by a hash of the text, so Apache-2.0 is stored once rather than 200 times.
  texts: Object.fromEntries(texts),
};

writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);

const withoutText = crates.filter((c) => c.texts.length === 0);
console.log(
  `${crates.length} crates, ${texts.size} distinct licence texts, ` +
    `${(JSON.stringify(snapshot).length / 1024).toFixed(0)} kB.`,
);
if (withoutText.length > 0) {
  console.log(
    `${withoutText.length} ship no licence text, so the notices cite their SPDX ` +
      `declaration: ${withoutText
        .slice(0, 5)
        .map((c) => c.name)
        .join(", ")}${withoutText.length > 5 ? ", …" : ""}`,
  );
}
