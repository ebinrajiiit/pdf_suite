import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, expect, test } from "vitest";
import { createPdfiumEngine, type PdfiumEngine } from "./index.js";

// PDFium's wasm runs under node, so this can use the real engine on a really
// encrypted file rather than a document that merely claims to be one.
const wasmBinary = readFileSync(
  new URL("../../node_modules/@embedpdf/pdfium/dist/pdfium.wasm", import.meta.url),
);

let engine: PdfiumEngine;
beforeAll(async () => {
  engine = await createPdfiumEngine({ wasmBinary: wasmBinary.buffer as ArrayBuffer });
});

async function plain(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 400]).drawText("Sanction is accorded.", { x: 50, y: 300, size: 12, font });
  return doc.save();
}

/**
 * Encrypted with an owner password and an *empty* user password: what a signing
 * tool leaves behind when it says no changes are allowed. qpdf is driven
 * directly because our own encrypt() requires a user password, and the point of
 * this fixture is a document that needs none to open.
 */
async function ownerLocked(bytes: Uint8Array): Promise<Uint8Array> {
  const require = createRequire(import.meta.url);
  const factory = (await import("@neslinesli93/qpdf-wasm")).default as unknown as (arg: {
    locateFile: () => string;
  }) => Promise<{
    callMain(args: string[]): number;
    FS: { writeFile(p: string, d: Uint8Array): void; readFile(p: string): Uint8Array };
  }>;
  const qpdf = await factory({
    locateFile: () => require.resolve("@neslinesli93/qpdf-wasm/dist/qpdf.wasm"),
  });
  qpdf.FS.writeFile("/in.pdf", bytes);
  const code = qpdf.callMain([
    "/in.pdf",
    "/out.pdf",
    "--encrypt",
    "--user-password=",
    "--owner-password=registrar",
    "--bits=256",
    "--modify=none",
    "--",
  ]);
  expect(code, "qpdf should have written the locked fixture").toBe(0);
  return qpdf.FS.readFile("/out.pdf");
}

test("a document with no encryption says so", async () => {
  const handle = await engine.open((await plain()).slice().buffer as ArrayBuffer);
  try {
    expect(handle.isEncrypted?.()).toBe(false);
  } finally {
    handle.close();
  }
});

test("a document locked against changes opens without a password and admits it", async () => {
  const locked = await ownerLocked(await plain());
  const handle = await engine.open(locked.slice().buffer as ArrayBuffer);
  try {
    // No password was passed, and it opened anyway: this is exactly why the
    // encryption has to be asked about rather than inferred from open failing.
    expect(handle.pageCount()).toBe(1);
    expect(handle.isEncrypted?.()).toBe(true);
  } finally {
    handle.close();
  }
});

test("a closed document is not asked about its encryption", async () => {
  const handle = await engine.open((await plain()).slice().buffer as ArrayBuffer);
  handle.close();
  expect(() => handle.isEncrypted?.()).toThrow();
});
