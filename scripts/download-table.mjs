#!/usr/bin/env node
// Renders the download table for the public repository's README, from the
// release that was just published.
//
// The asset names carry the version, so a hand-written link rots at the next
// release — and a dead download link on the page a stranger lands on is worse
// than no link. The release workflow regenerates the block between the markers
// each time.
//
//   gh api repos/OWNER/REPO/releases/tags/vX.Y.Z | node scripts/download-table.mjs vX.Y.Z
//   ... | node scripts/download-table.mjs vX.Y.Z --into README.md
//   ... | node scripts/download-table.mjs vX.Y.Z --notes
import { readFileSync, writeFileSync } from "node:fs";

const START = "<!-- downloads:start -->";
const END = "<!-- downloads:end -->";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: download-table.mjs <tag>   (release JSON on stdin)");
  process.exit(2);
}

/** @type {{ html_url: string, assets: { name: string, size: number, browser_download_url: string }[] }} */
const release = JSON.parse(readFileSync(0, "utf8"));

// Named by the computer someone has, not by the packaging they have never
// heard of. Order is the order people arrive in.
const ROWS = [
  [/universal\.dmg$/, "**Mac** — any Mac, Intel or Apple silicon"],
  [/\.msi$/, "**Windows** — 10 or 11"],
  [/\.deb$/, "**Linux** — Ubuntu, Debian, Mint, Pop!_OS"],
  [/\.AppImage$/, "**Linux** — Fedora, Arch, openSUSE, anything else"],
  [/^signet-web\.tar\.gz$/, "**A whole office** — serve it from your own machine"],
];

const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;

const lines = ["| Your computer | Click to download | Size |", "| --- | --- | --- |"];
for (const [pattern, who] of ROWS) {
  const asset = release.assets.find((a) => pattern.test(a.name));
  if (!asset) {
    console.error(`no asset matched ${pattern}`);
    process.exit(1);
  }
  lines.push(`| ${who} | **[${asset.name}](${asset.browser_download_url})** | ${mb(asset.size)} |`);
}

lines.push("");
lines.push(
  `<sub>Signet ${tag.replace(/^v/, "")} · ` +
    `[every file, with checksums](${release.html_url})</sub>`,
);

const table = lines.join("\n");

// The release page is where most people arrive, and it lists bare filenames
// under Assets with nothing saying which is theirs. Same table, same links.
if (process.argv.includes("--notes")) {
  console.log(
    [
      "Every operation runs on your own device. No document, page, extracted",
      "text or derived data leaves the machine.",
      "",
      "## Download the one for your computer",
      "",
      table,
      "",
      "### What to do with it",
      "",
      "- **`.dmg`** — open it and drag Signet into Applications.",
      "- **`.msi`** — double-click it and follow the installer.",
      "- **`.deb`** — double-click it, or `sudo apt install ./Signet_*.deb`",
      "- **`.AppImage`** — `chmod +x Signet_*.AppImage`, then run it. Nothing is",
      "  installed; the single file is the whole program.",
      "- **`signet-web.tar.gz`** — unpack into any folder your web server serves.",
      "",
      "### The first time you open it, your computer will warn you",
      "",
      "Signet is not code-signed yet, so macOS and Windows say an unidentified",
      "developer made this. It is us.",
      "",
      "- **macOS:** right-click Signet in Applications and choose **Open**, then",
      "  **Open** again. Only needed once — double-clicking the first time gives",
      "  you no Open button at all.",
      "- **Windows:** SmartScreen shows a blue box. Click **More info**, then",
      "  **Run anyway**.",
      "",
      "`SHA256SUMS` below checks any download: `shasum -a 256 <file>` on macOS or",
      "Linux, `Get-FileHash <file>` in Windows PowerShell.",
      "",
      "The OCR language data for English, Malayalam and Hindi is inside every",
      "build, which is why they are large — and why OCR works offline.",
    ].join("\n"),
  );
  process.exit(0);
}

const into = process.argv.indexOf("--into");
if (into === -1) {
  console.log(table);
} else {
  const file = process.argv[into + 1];
  const page = readFileSync(file, "utf8");
  const from = page.indexOf(START);
  const to = page.indexOf(END);
  if (from === -1 || to === -1 || to < from) {
    console.error(`${file} has no ${START} … ${END} block to replace`);
    process.exit(1);
  }
  const next = page.slice(0, from + START.length) + "\n" + table + "\n" + page.slice(to);
  if (next === page) {
    console.log("Download links already current.");
  } else {
    writeFileSync(file, next);
    console.log(`Rewrote the download links in ${file}.`);
  }
}
