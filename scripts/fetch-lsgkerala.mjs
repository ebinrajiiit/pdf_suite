#!/usr/bin/env node
// Collects Malayalam PDFs from lsgkerala.gov.in — the Kerala Local Self
// Government Department's circulars, government orders and acts. These are
// public documents in Malayalam from exactly the kind of office this product is
// for, which is what the corpus has been missing.
//
// It is deliberately a slow, small crawler:
//   * robots.txt is fetched and its Disallow rules are obeyed, including
//     /lbelection/electdmemberpersondet/ — elected members' personal details,
//     which we would not want even if crawling them were allowed.
//   * one request at a time, with a delay between them.
//   * a page budget and a file budget, both capped by default.
//   * files already on disk are never re-fetched.
//
// Nothing downloaded is committed: corpus/ is git-ignored. Provenance goes in
// corpus/PROVENANCE.json.
//
//   node scripts/fetch-lsgkerala.mjs [--limit 60] [--pages 40] [--delay 1200]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ORIGIN = "https://lsgkerala.gov.in";
const UA =
  "pdf-suite-corpus/0.1 (+IIIT Kottayam FACTS-H lab; local PDF test corpus; contact the repository owner)";

const repoRoot = resolve(import.meta.dirname, "..");
const corpusDir = join(repoRoot, "corpus");
const outDir = join(corpusDir, "lsgkerala");

const argv = process.argv.slice(2);
const num = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(argv[i + 1]);
};
const fileLimit = num("limit", 60);
const pageLimit = num("pages", 40);
const delayMs = num("delay", 1200);
/** Skip anything larger than this: the corpus wants variety, not bulk. */
const maxBytes = num("max-mb", 25) * 1024 * 1024;

/**
 * Malayalam sections of the main site. Documents here are served from
 * /system/files/, which this host's robots.txt allows.
 *
 * The department's circulars and government orders are NOT here: /ml/circulars
 * just links to go.lsgkerala.gov.in, whose robots.txt says `Disallow: /files`
 * — the directory its documents live in. We do not crawl those. Download them
 * by hand from the portal if they are needed and drop them in corpus/.
 */
const SEEDS = [
  "/ml",
  "/ml/best-practices",
  "/ml/e-governance",
  "/ml/act-rule",
  "/ml/news",
  "/ml/notifications",
  "/ml/flood-relief/gos",
  "/ml/projects",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, as = "text") {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return undefined;
  return as === "text" ? res.text() : Buffer.from(await res.arrayBuffer());
}

/** Disallow rules for our user agent, from the site's own robots.txt. */
async function disallowRules() {
  const text = await get(`${ORIGIN}/robots.txt`);
  if (!text) {
    throw new Error("could not read robots.txt; refusing to crawl without it");
  }
  const rules = [];
  let applies = false;
  for (const line of text.split("\n")) {
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") applies = value === "*";
    else if (applies && key === "disallow" && value !== "") rules.push(value);
    else if (applies && key === "crawl-delay" && Number(value) > 0) {
      rules.crawlDelay = Number(value) * 1000;
    }
  }
  return rules;
}

const rules = await disallowRules();
const wait = Math.max(delayMs, rules.crawlDelay ?? 0);
const allowed = (path) => !rules.some((rule) => path.startsWith(rule));

console.log(`robots.txt: ${rules.length} Disallow rules, waiting ${wait} ms between requests`);

/** Absolute, same-origin URLs only; everything else is someone else's server. */
function sameOrigin(href, base) {
  try {
    const url = new URL(href, base);
    if (url.origin !== ORIGIN && url.origin !== ORIGIN.replace("https:", "http:")) return undefined;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

const pdfUrls = new Map();
const visited = new Set();
const queue = SEEDS.map((p) => new URL(ORIGIN + p));

console.log(`\nCrawling up to ${pageLimit} listing pages for PDF links…`);
while (queue.length > 0 && visited.size < pageLimit) {
  const page = queue.shift();
  if (!page || visited.has(page.href)) continue;
  visited.add(page.href);
  if (!allowed(page.pathname)) continue;

  await sleep(wait);
  const html = await get(page.href);
  if (typeof html !== "string") continue;

  let found = 0;
  for (const match of html.matchAll(/href="([^"]+)"/gi)) {
    const url = sameOrigin(match[1], page.href);
    if (!url || !allowed(url.pathname)) continue;

    if (url.pathname.toLowerCase().endsWith(".pdf")) {
      if (!pdfUrls.has(url.href)) {
        pdfUrls.set(url.href, page.href);
        found++;
      }
      continue;
    }
    // Follow pagination, and Malayalam content pages one level deep, since the
    // PDF is usually attached to an article rather than listed directly. Bounded
    // by the page budget so the crawl stays small and predictable.
    const isMalayalamPage = url.pathname.startsWith("/ml/") && !url.pathname.includes(".");
    const worthFollowing = url.searchParams.has("page") || isMalayalamPage;
    if (worthFollowing && !visited.has(url.href) && queue.length < pageLimit * 3) {
      queue.push(url);
    }
  }
  console.log(`  ${page.pathname}${page.search}  +${found} PDFs (${pdfUrls.size} total)`);
  if (pdfUrls.size >= fileLimit * 2) break;
}

console.log(`\nFound ${pdfUrls.size} PDF links. Downloading up to ${fileLimit}…`);
mkdirSync(outDir, { recursive: true });

const provenance = [];
let downloaded = 0;
let skipped = 0;
let bytesTotal = 0;

for (const [url, foundOn] of pdfUrls) {
  if (downloaded >= fileLimit) break;
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "")
    .replace(/[^\w.-]+/g, "_")
    .slice(-120);
  if (!name.toLowerCase().endsWith(".pdf")) continue;
  const file = join(outDir, name);

  let bytes;
  if (existsSync(file)) {
    bytes = readFileSync(file);
    skipped++;
  } else {
    await sleep(wait);
    bytes = await get(url, "bytes");
    if (!bytes || bytes.length > maxBytes) continue;
    // A Drupal error page comes back with a 200 and no PDF header.
    if (!bytes.subarray(0, 5).toString("latin1").startsWith("%PDF")) continue;
    writeFileSync(file, bytes);
    downloaded++;
    bytesTotal += bytes.length;
    if (downloaded % 10 === 0) console.log(`  ${downloaded} downloaded…`);
  }

  provenance.push({
    file: `lsgkerala/${name}`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source: url,
    foundOn,
    licence: "Government of Kerala, published publicly; no licence stated",
    kind: "real document, downloaded — Kerala LSGD (Malayalam)",
  });
}

// Merge with whatever else is recorded, so this never erases another run.
const manifestFile = join(corpusDir, "PROVENANCE.json");
const existing = existsSync(manifestFile)
  ? (JSON.parse(readFileSync(manifestFile, "utf8")).files ?? [])
  : [];
const merged = [
  ...existing.filter((e) => !provenance.some((p) => p.file === e.file)),
  ...provenance,
].sort((a, b) => a.file.localeCompare(b.file));

writeFileSync(
  manifestFile,
  JSON.stringify(
    {
      $comment:
        "Where every file in corpus/ came from. corpus/ is git-ignored; this file is not. " +
        "Written by scripts/fetch-sample-corpus.mjs and scripts/fetch-lsgkerala.mjs.",
      generatedAt: new Date().toISOString(),
      files: merged,
    },
    null,
    2,
  ),
);

console.log(
  `\n${downloaded} downloaded (${(bytesTotal / 1048576).toFixed(1)} MB), ` +
    `${skipped} already present. corpus/ now records ${merged.length} files.`,
);
console.log("These are public Kerala government documents, kept locally for testing only.");
console.log("\nNext: pnpm corpus   and   pnpm bench:engines");
