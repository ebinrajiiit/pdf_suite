import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { toDocx } from "./docx.js";
import { crc32, zip } from "./zip.js";

const run = promisify(execFile);

test("the zip writer produces an archive the system can open", async () => {
  const archive = zip([
    { name: "hello.txt", data: new TextEncoder().encode("hello") },
    { name: "nested/other.txt", data: new TextEncoder().encode("other") },
  ]);

  // Checked with unzip rather than with our own reader: an archive only this
  // code can open is not an archive.
  const dir = await mkdtemp(join(tmpdir(), "pdf-suite-zip-"));
  const path = join(dir, "test.zip");
  await writeFile(path, archive);

  const { stdout } = await run("unzip", ["-l", path]);
  expect(stdout).toContain("hello.txt");
  expect(stdout).toContain("nested/other.txt");

  const { stdout: contents } = await run("unzip", ["-p", path, "hello.txt"]);
  expect(contents).toBe("hello");
});

test("the checksum is the one zip expects", async () => {
  // A known value: CRC-32 of "123456789" is 0xCBF43926.
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  expect(crc32(new Uint8Array())).toBe(0);
});

test("a document carries each page's words, with a break between pages", async () => {
  const docx = toDocx(["First page\nsecond line", "Second page"], { title: "Circular 12" });

  const dir = await mkdtemp(join(tmpdir(), "pdf-suite-docx-"));
  const path = join(dir, "out.docx");
  await writeFile(path, docx);

  // The parts Word insists on.
  const { stdout: listing } = await run("unzip", ["-l", path]);
  expect(listing).toContain("[Content_Types].xml");
  expect(listing).toContain("_rels/.rels");
  expect(listing).toContain("word/document.xml");

  const { stdout: document } = await run("unzip", ["-p", path, "word/document.xml"]);
  expect(document).toContain("Circular 12");
  expect(document).toContain("First page");
  expect(document).toContain("second line");
  expect(document).toContain("Second page");
  expect(document).toContain('w:type="page"');
});

test("characters XML cannot carry are escaped or dropped, not written raw", async () => {
  const docx = toDocx(["Fees < 500 & rising\u0007"], {});
  const dir = await mkdtemp(join(tmpdir(), "pdf-suite-docx-"));
  const path = join(dir, "out.docx");
  await writeFile(path, docx);

  const { stdout } = await run("unzip", ["-p", path, "word/document.xml"]);
  expect(stdout).toContain("Fees &lt; 500 &amp; rising");
  // The control character is gone rather than making the file unreadable.
  expect(stdout).not.toContain("\u0007");
});

test("an empty document is still a document", async () => {
  const docx = toDocx([], {});
  const dir = await mkdtemp(join(tmpdir(), "pdf-suite-docx-"));
  const path = join(dir, "empty.docx");
  await writeFile(path, docx);
  const { stdout } = await run("unzip", ["-p", path, "word/document.xml"]);
  expect(stdout).toContain("<w:body>");
});
