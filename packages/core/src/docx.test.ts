import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { blocksFromGrid, toDocx } from "./docx.js";
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

/** Writes the .docx and gives back word/document.xml, as Word would read it. */
async function documentXml(docx: Uint8Array, name = "out.docx"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdf-suite-docx-"));
  const path = join(dir, name);
  await writeFile(path, docx);
  const { stdout } = await run("unzip", ["-p", path, "word/document.xml"]);
  return stdout;
}

test("a document carries each page's words, with a break between pages", async () => {
  const docx = toDocx(
    [
      { blocks: [{ kind: "paragraph", text: "First page" }] },
      { blocks: [{ kind: "paragraph", text: "Second page" }] },
    ],
    { title: "Circular 12" },
  );

  const dir = await mkdtemp(join(tmpdir(), "pdf-suite-docx-"));
  const path = join(dir, "out.docx");
  await writeFile(path, docx);

  // The parts Word insists on.
  const { stdout: listing } = await run("unzip", ["-l", path]);
  expect(listing).toContain("[Content_Types].xml");
  expect(listing).toContain("_rels/.rels");
  expect(listing).toContain("word/_rels/document.xml.rels");
  expect(listing).toContain("word/document.xml");

  const { stdout: document } = await run("unzip", ["-p", path, "word/document.xml"]);
  expect(document).toContain("Circular 12");
  expect(document).toContain("First page");
  expect(document).toContain("Second page");
  expect(document).toContain('w:type="page"');
});

test("a paragraph is one paragraph, however many lines it had in the PDF", async () => {
  // The whole point: a wrapped paragraph arrives as one block of text and has
  // to leave as one <w:p>. One per line is what makes an exported document
  // impossible to edit — every line ends in a paragraph mark.
  const sentence =
    "All heads of department are informed that the revised fee structure " +
    "takes effect from the first of April.";
  const xml = await documentXml(
    toDocx([
      {
        blocks: [
          { kind: "paragraph", text: "Office Memorandum", size: 16, bold: true },
          { kind: "paragraph", text: sentence, size: 11 },
        ],
      },
    ]),
  );

  expect(xml).toContain(sentence);
  // Two paragraphs on the page, not six.
  expect(xml.match(/<w:p>/g)).toHaveLength(2);
  // The heading keeps its weight and its size; Word counts in half-points.
  expect(xml).toContain('<w:b/><w:sz w:val="32"/>');
  expect(xml).toContain('<w:sz w:val="22"/>');
});

test("a page that is a table comes out as a table", async () => {
  const xml = await documentXml(
    toDocx([
      {
        blocks: [
          {
            kind: "table",
            rows: [
              ["Roll", "Name", "Marks"],
              ["1", "A", "90"],
            ],
          },
        ],
      },
    ]),
  );

  expect(xml).toContain("<w:tbl>");
  expect(xml.match(/<w:tr>/g)).toHaveLength(2);
  expect(xml.match(/<w:tc>/g)).toHaveLength(6);
  expect(xml).toContain("Marks");
  // A table has to be followed by a paragraph or Word calls the file corrupt.
  expect(xml).toContain("</w:tbl><w:p/>");
});

test("a row with fewer cells is padded rather than left short", async () => {
  const xml = await documentXml(
    toDocx([{ blocks: [{ kind: "table", rows: [["a", "b", "c"], ["only"]] }] }]),
  );
  // Six cells, not four: a short row in Word is a broken table.
  expect(xml.match(/<w:tc>/g)).toHaveLength(6);
});

test("the page size is the PDF's own, landscape included", async () => {
  const portrait = await documentXml(toDocx([{ blocks: [], width: 595, height: 842 }]));
  expect(portrait).toContain('<w:pgSz w:w="11900" w:h="16840"/>');

  const landscape = await documentXml(
    toDocx([{ blocks: [{ kind: "paragraph", text: "Wide" }], width: 842, height: 595 }]),
  );
  expect(landscape).toContain('w:w="16840" w:h="11900" w:orient="landscape"');
});

test("characters XML cannot carry are escaped or dropped, not written raw", async () => {
  const stdout = await documentXml(
    toDocx([{ blocks: [{ kind: "paragraph", text: "Fees < 500 & rising\u0007" }] }]),
  );
  expect(stdout).toContain("Fees &lt; 500 &amp; rising");
  // The control character is gone rather than making the file unreadable.
  expect(stdout).not.toContain("\u0007");
});

test("an empty document is still a document", async () => {
  const stdout = await documentXml(toDocx([], {}), "empty.docx");
  expect(stdout).toContain("<w:body>");
});

test("the heading above a table is a heading, not a cell of it", () => {
  const blocks = blocksFromGrid(
    [
      ["Annexure A", "", "", ""],
      ["Roll", "Name", "Internal", "Total"],
      ["21001", "Anita", "38", "90"],
      ["21002", "Bimal", "35", "85"],
      ["Checked by the office", "", "", ""],
    ],
    (text) => (text === "Annexure A" ? { size: 14, bold: true } : undefined),
  );

  expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "table", "paragraph"]);
  expect(blocks[0]).toEqual({ kind: "paragraph", text: "Annexure A", size: 14, bold: true });
  expect(blocks[1]).toEqual({
    kind: "table",
    rows: [
      ["Roll", "Name", "Internal", "Total"],
      ["21001", "Anita", "38", "90"],
      ["21002", "Bimal", "35", "85"],
    ],
  });
  expect(blocks[2]).toEqual({ kind: "paragraph", text: "Checked by the office" });
});

test("a single row with a gap in it is a line, not a one-row table", () => {
  const blocks = blocksFromGrid([
    ["Date", "20 October"],
    ["Signed at the office of the registrar", "", ""],
  ]);
  // The first row fills two columns, but one row on its own is not a table.
  expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "paragraph"]);
  expect(blocks[0]).toEqual({ kind: "paragraph", text: "Date 20 October" });
});

test("a row that breaks a table in two leaves two tables", () => {
  const blocks = blocksFromGrid([
    ["Roll", "Marks"],
    ["1", "90"],
    ["Second semester", ""],
    ["Roll", "Marks"],
    ["2", "85"],
  ]);
  expect(blocks.map((block) => block.kind)).toEqual(["table", "paragraph", "table"]);
});
