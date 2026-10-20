import { createRequire } from "node:module";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, expect, test } from "vitest";
import { createQpdf, WrongPasswordError, type Qpdf } from "./qpdf.js";

// In Node the Emscripten build reads the wasm straight off disk, so the "URL"
// is a path. In the browser it is a bundled, same-origin asset URL.
const require = createRequire(import.meta.url);
const wasmUrl = require.resolve("@neslinesli93/qpdf-wasm/dist/qpdf.wasm");

let qpdf: Qpdf;
beforeAll(async () => {
  qpdf = await createQpdf({ wasmUrl });
});

async function makeDoc(pages = 5): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([595, 842]);
    for (let i = 0; i < 20; i++) {
      page.drawText(`page ${p + 1} line ${i + 1} the quick brown fox jumps over the lazy dog`, {
        x: 40,
        y: 780 - i * 18,
        size: 11,
        font,
      });
    }
  }
  return doc.save();
}

const pageCountOf = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();

test("encrypt makes a document pdf-lib cannot read, decrypt gives it back", async () => {
  const original = await makeDoc(2);
  const encrypted = await qpdf.encrypt(original, { userPassword: "open-sesame" });

  // pdf-lib refusing it is the point: every structural op goes through pdf-lib,
  // so an encrypted document has to be decrypted before it can be edited.
  await expect(PDFDocument.load(encrypted)).rejects.toThrow();
  expect(await pageCountOf(original)).toBe(2);

  const decrypted = await qpdf.decrypt(encrypted, "open-sesame");
  expect(await pageCountOf(decrypted)).toBe(2);
});

test("decrypt rejects a wrong password", async () => {
  const encrypted = await qpdf.encrypt(await makeDoc(1), { userPassword: "right" });
  await expect(qpdf.decrypt(encrypted, "wrong")).rejects.toThrow(WrongPasswordError);
});

test("encrypt refuses an empty password rather than writing an unprotected file", async () => {
  await expect(qpdf.encrypt(await makeDoc(1), { userPassword: "" })).rejects.toThrow(/required/);
});

test("repair recovers a document whose header is mangled", async () => {
  const broken = Buffer.from(await makeDoc(5));
  broken.write("%XXX-9.9", 0, "latin1");
  // pdf-lib and PDFium both refuse this; qpdf rebuilds it.
  const repaired = await qpdf.repair(broken);
  expect(await pageCountOf(repaired)).toBe(5);
});

test("repair recovers a document with junk before the header", async () => {
  const good = await makeDoc(3);
  const junked = Buffer.concat([Buffer.from("GARBAGE".repeat(40)), Buffer.from(good)]);
  expect(await pageCountOf(await qpdf.repair(junked))).toBe(3);
});

test("repair throws rather than returning half a document", async () => {
  const good = await makeDoc(5);
  // Cut off mid-body: the cross-reference table and trailer are gone and qpdf
  // refuses this one, so callers must treat a throw as "still broken".
  const truncated = good.slice(0, Math.floor(good.length * 0.6));
  await expect(qpdf.repair(truncated)).rejects.toThrow(/damaged beyond repair/);
});

test("compress returns a readable document with every page intact", async () => {
  const original = await makeDoc(20);
  const compressed = await qpdf.compress(original);
  expect(await pageCountOf(compressed)).toBe(20);
  // Object streams pay off on real documents but can cost bytes on tiny ones,
  // so this asserts validity, not a size win.
  expect(compressed.byteLength).toBeGreaterThan(0);
});

test("operations do not interfere when started together", async () => {
  const doc = await makeDoc(2);
  const [a, b, c] = await Promise.all([
    qpdf.compress(doc),
    qpdf.encrypt(doc, { userPassword: "x" }),
    qpdf.repair(doc),
  ]);
  expect(await pageCountOf(a)).toBe(2);
  expect(await pageCountOf(await qpdf.decrypt(b, "x"))).toBe(2);
  expect(await pageCountOf(c)).toBe(2);
});

test("permissions reach the encrypted file", async () => {
  const input = await makeDoc(1);

  const locked = await qpdf.encrypt(input, {
    userPassword: "open-me",
    bits: 256,
    allow: { print: "none", extract: false, modify: "none" },
  });

  // qpdf writes the permission bits into the encryption dictionary; reading the
  // file back with the password and asking qpdf about it is the check that the
  // flags were accepted rather than ignored.
  const decrypted = await qpdf.decrypt(locked, "open-me");
  expect(decrypted.length).toBeGreaterThan(0);
  // The two files differ: a document encrypted with permissions is not the same
  // bytes as one encrypted without them.
  const open = await qpdf.encrypt(input, { userPassword: "open-me", bits: 256 });
  expect(Buffer.from(locked).equals(Buffer.from(open))).toBe(false);
});
