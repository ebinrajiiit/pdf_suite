#!/usr/bin/env node
// Fetches a small starter corpus of real, openly licensed documents, plus the
// synthetic edge cases that are better made than found.
//
// This is a stand-in, not the corpus. It exists so the engine benchmark, the
// OCR spike and `pnpm corpus` have real-world material — scanned pages, real
// Malayalam and Devanagari, genuine generator quirks — instead of only PDFs we
// wrote ourselves. The institutional cases that matter most (grade cards, exam
// papers, signed office correspondence) cannot be downloaded and must come from
// the lab, de-identified (CLAUDE.md §6).
//
// Nothing fetched here is committed: corpus/ is git-ignored. Provenance and
// licence for every file land in corpus/PROVENANCE.json. Items whose rights are
// not stated upstream are kept — they are useful test material — but marked, so
// nobody mistakes "it downloaded" for "we may redistribute it".
//
//   node scripts/fetch-sample-corpus.mjs [--limit 6] [--skip-remote]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const corpusDir = join(repoRoot, "corpus");
const argv = process.argv.slice(2);
const limit = Number(argv.includes("--limit") ? argv[argv.indexOf("--limit") + 1] : 6);
const skipRemote = argv.includes("--skip-remote");

/**
 * Searches archive.org. These are the closest public documents to the real use
 * case: Indian government material, in Malayalam and Hindi, much of it scanned.
 */
const SEARCHES = [
  {
    folder: "scanned",
    label: "Malayalam government documents (Kerala Assembly proceedings and similar)",
    query: "language:(malayalam) AND mediatype:(texts)",
  },
  {
    folder: "scanned",
    label: "Hindi government documents",
    query: "language:(hindi) AND mediatype:(texts)",
  },
];

async function searchArchive(query, rows) {
  const url =
    "https://archive.org/advancedsearch.php?q=" +
    encodeURIComponent(query) +
    "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=licenseurl&fl%5B%5D=rights" +
    `&rows=${rows}&page=1&output=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`archive.org search failed: HTTP ${res.status}`);
  return (await res.json()).response?.docs ?? [];
}

async function pdfForItem(identifier) {
  const res = await fetch(`https://archive.org/metadata/${identifier}`);
  if (!res.ok) return undefined;
  const meta = await res.json();
  const pdf = (meta.files ?? [])
    .filter((f) => f.name.toLowerCase().endsWith(".pdf"))
    // Smallest first: a starter corpus wants variety, not volume.
    .sort((a, b) => Number(a.size ?? 0) - Number(b.size ?? 0))[0];
  if (!pdf) return undefined;
  return {
    url: `https://archive.org/download/${identifier}/${encodeURIComponent(pdf.name)}`,
    size: Number(pdf.size ?? 0),
    rights: meta.metadata?.licenseurl ?? meta.metadata?.rights ?? "not stated",
    title: meta.metadata?.title ?? identifier,
  };
}

/**
 * Fetches a document, or reads the copy already on disk. Re-running then costs
 * nothing and still records provenance for everything present.
 */
async function download(url, folder, name) {
  const file = join(corpusDir, folder, name);
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch(url);
  if (!res.ok) return undefined;
  const bytes = Buffer.from(await res.arrayBuffer());
  // Some items hand back an HTML error page with a 200.
  return bytes.subarray(0, 5).toString("latin1").startsWith("%PDF") ? bytes : undefined;
}

const provenance = [];

function record(entry) {
  provenance.push(entry);
  console.log(
    `  ${entry.file.padEnd(46)} ${(entry.bytes / 1024).toFixed(0).padStart(6)} kB  ${entry.licence}`,
  );
}

async function save(folder, name, bytes, meta) {
  const dir = join(corpusDir, folder);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, bytes);
  record({
    file: `${folder}/${name}`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...meta,
  });
}

// ---- real documents ----
if (!skipRemote) {
  for (const search of SEARCHES) {
    console.log(`\n${search.label}`);
    let found = 0;
    const deferred = [];
    let takingUnstated = false;
    try {
      const docs = await searchArchive(search.query, limit * 3);
      for (const doc of docs) {
        if (found >= limit) break;
        const pdf = await pdfForItem(doc.identifier);
        if (!pdf || pdf.size === 0 || pdf.size > 80 * 1024 * 1024) continue;
        // Prefer items that state their licence. Unstated ones are still worth
        // testing against, so they are taken on a second pass, clearly marked.
        const stated = pdf.rights !== "not stated";
        if (!stated && !takingUnstated) {
          deferred.push({ doc, pdf });
          continue;
        }
        const bytes = await download(pdf.url, search.folder, `${doc.identifier}.pdf`);
        if (!bytes) continue;
        await save(search.folder, `${doc.identifier}.pdf`, bytes, {
          source: pdf.url,
          title: String(pdf.title).slice(0, 120),
          licence: pdf.rights,
          kind: stated
            ? "real document, downloaded"
            : "real document, downloaded — RIGHTS NOT STATED upstream: local testing only",
        });
        found++;
      }

      // Nothing with a stated licence? Take the unstated ones rather than having
      // no real documents at all, and say so.
      if (found === 0 && deferred.length > 0) {
        takingUnstated = true;
        for (const { doc, pdf } of deferred.slice(0, limit)) {
          const bytes = await download(pdf.url, search.folder, `${doc.identifier}.pdf`);
          if (!bytes) continue;
          await save(search.folder, `${doc.identifier}.pdf`, bytes, {
            source: pdf.url,
            title: String(pdf.title).slice(0, 120),
            licence: pdf.rights,
            kind: "real document, downloaded — RIGHTS NOT STATED upstream: local testing only",
          });
          found++;
        }
      }
    } catch (err) {
      console.error(`  could not fetch: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (found === 0) console.log("  nothing usable found");
  }
}

// ---- synthetic edge cases ----
// These are better made than found: you cannot reliably download a file with a
// deliberately broken cross-reference table, and a real one would come with
// someone's data attached.
console.log("\nSynthetic edge cases (deliberately broken, encrypted, or huge)");
const { PDFDocument, StandardFonts, degrees } = await import("pdf-lib");

async function textDoc(pages, lines, size = [595.28, 841.89]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(size);
    for (let i = 0; i < lines; i++) {
      page.drawText(`Page ${p + 1} line ${i + 1}: result sheet entry ${p * lines + i}`, {
        x: 48,
        y: 780 - i * 18,
        size: 11,
        font,
      });
    }
  }
  return Buffer.from(await doc.save());
}

const plain = await textDoc(3, 30);
await save(
  "malformed",
  "header-mangled.pdf",
  (() => {
    const b = Buffer.from(plain);
    b.write("%XXX-9.9", 0, "latin1");
    return b;
  })(),
  { kind: "synthetic: header destroyed (qpdf can repair this)", licence: "n/a — generated" },
);

await save(
  "malformed",
  "junk-before-header.pdf",
  Buffer.concat([Buffer.from("GARBAGE".repeat(60)), plain]),
  {
    kind: "synthetic: junk prepended (qpdf can repair this)",
    licence: "n/a — generated",
  },
);

await save("malformed", "truncated.pdf", plain.subarray(0, Math.floor(plain.length * 0.6)), {
  kind: "synthetic: cut off mid-body (qpdf cannot repair this; it must fail cleanly)",
  licence: "n/a — generated",
});

const rotated = await PDFDocument.create();
const rotatedFont = await rotated.embedFont(StandardFonts.TimesRoman);
for (const angle of [0, 90, 180, 270]) {
  const page = rotated.addPage([595.28, 841.89]);
  page.setRotation(degrees(angle));
  page.drawText(`Rotated ${angle} degrees`, { x: 48, y: 700, size: 18, font: rotatedFont });
}
await save("malformed", "rotated-pages.pdf", Buffer.from(await rotated.save()), {
  kind: "synthetic: every page rotation, which page sizing gets wrong if mishandled",
  licence: "n/a — generated",
});

await save("large", "500-pages.pdf", await textDoc(500, 30), {
  kind: "synthetic: 500 pages, for virtualisation and batch timing",
  licence: "n/a — generated",
});

// Encrypted, via the qpdf we already ship.
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(join(repoRoot, "packages/core/"));
  const createQpdf = require("@neslinesli93/qpdf-wasm");
  const qpdf = await createQpdf({
    locateFile: () => require.resolve("@neslinesli93/qpdf-wasm/dist/qpdf.wasm"),
  });
  qpdf.FS.writeFile("/in.pdf", await textDoc(2, 20));
  if (qpdf.callMain(["/in.pdf", "/out.pdf", "--encrypt", "corpus", "corpus", "256", "--"]) === 0) {
    await save("signed", "password-corpus.pdf", Buffer.from(qpdf.FS.readFile("/out.pdf")), {
      kind: "synthetic: AES-256 encrypted, password is `corpus`",
      licence: "n/a — generated",
    });
  }
} catch (err) {
  console.error(`  encrypted sample skipped: ${err instanceof Error ? err.message : err}`);
}

// ---- provenance ----
// Merge rather than overwrite: a --skip-remote run would otherwise erase the
// record of the downloaded documents it did not touch.
const existing = existsSync(join(corpusDir, "PROVENANCE.json"))
  ? (JSON.parse(readFileSync(join(corpusDir, "PROVENANCE.json"), "utf8")).files ?? [])
  : [];
const merged = [
  ...existing.filter((e) => !provenance.some((p) => p.file === e.file)),
  ...provenance,
].sort((a, b) => a.file.localeCompare(b.file));

const manifest = {
  $comment:
    "Where every file in corpus/ came from, and under what licence. Written by " +
    "scripts/fetch-sample-corpus.mjs. corpus/ is git-ignored; this file records " +
    "that the downloaded documents are openly licensed and that the rest are generated.",
  generatedAt: new Date().toISOString(),
  files: merged,
};
writeFileSync(join(corpusDir, "PROVENANCE.json"), JSON.stringify(manifest, null, 2));

const total = merged.reduce((n, p) => n + p.bytes, 0);
const real = merged.filter((p) => p.kind.startsWith("real")).length;
const unstated = merged.filter((p) => p.kind.includes("RIGHTS NOT STATED")).length;
console.log(
  `\n${merged.length} files in corpus/, ${(total / 1048576).toFixed(1)} MB ` +
    `(${real} real, ${merged.length - real} generated). Provenance: corpus/PROVENANCE.json`,
);
if (unstated > 0) {
  console.log(
    `\n${unstated} downloaded file(s) do not state their rights upstream. They are fine as\n` +
      "test material on your own machine, and corpus/ is never committed, but do not\n" +
      "redistribute them or ship them with anything.",
  );
}

console.log("\nStill missing, and only the lab can supply it:");
console.log("  - grade cards, mark lists and exam papers as your office actually produces them");
console.log("  - letters and office correspondence, scanned on your own scanners");
console.log("  - documents signed with a Class 3 DSC");
console.log("  - AcroForms your departments circulate");
console.log("  De-identify before adding: no real student or patient data (CLAUDE.md §6).");
console.log("\nThen: pnpm corpus   and   pnpm bench:engines");
