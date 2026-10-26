import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { expect, test } from "vitest";
import { isSigned, readSignatures } from "./signatures.js";

/**
 * A document carrying a signature dictionary. The cryptography is not real —
 * what is being tested is what the file says about itself and whether anything
 * was appended after the signed region.
 */
async function signed(options: { appended?: string; coversAll?: boolean } = {}) {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);

  const value = doc.context.register(
    doc.context.obj({
      Type: "Sig",
      Filter: PDFName.of("Adobe.PPKLite"),
      SubFilter: PDFName.of("adbe.pkcs7.detached"),
      Name: PDFString.of("The Registrar, IIIT Kottayam"),
      M: PDFString.of("D:20261020101500+05'30'"),
      Reason: PDFString.of("Approved"),
      Location: PDFString.of("Kottayam"),
      Contents: PDFHexString.of("00".repeat(16)),
      // A placeholder, patched to the real offsets after saving.
      ByteRange: [0, 100, 200, 300],
    }),
  );
  const field = doc.context.register(
    doc.context.obj({ FT: PDFName.of("Sig"), T: PDFString.of("registrar.sig"), V: value }),
  );
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [field], SigFlags: 3 }));

  // Uncompressed, so the byte range can be patched in place as a signer does;
  // object streams would hide it.
  const bytes = await doc.save({ useObjectStreams: false });

  // Patch the byte range to the file that was actually produced, the way a
  // signer does: the placeholder is written first and the real offsets go in
  // afterwards, in the same number of characters so nothing else moves.
  const text = new TextDecoder("latin1").decode(bytes);
  const placeholder = "/ByteRange [ 0 100 200 300 ]";
  const start = text.indexOf("/ByteRange");
  expect(start, "the fixture has to carry a byte range to patch").toBeGreaterThan(0);
  const length = text.indexOf("]", start) + 1 - start;
  const covered = options.coversAll === false ? bytes.length - 200 : bytes.length;
  const real = `/ByteRange [0 100 200 ${covered - 200}]`.padEnd(length, " ");
  expect(real.length, "the patched range must not move anything").toBe(length);

  const patched = new Uint8Array(bytes);
  patched.set(new TextEncoder().encode(real), start);
  expect(placeholder.length).toBeGreaterThan(0);
  return patched;
}

test("reads who signed, when, and why", async () => {
  const signatures = await readSignatures(await signed());
  expect(signatures).toHaveLength(1);
  expect(signatures[0]?.field).toBe("registrar.sig");
  expect(signatures[0]?.signer).toBe("The Registrar, IIIT Kottayam");
  expect(signatures[0]?.date).toContain("20261020");
  expect(signatures[0]?.reason).toBe("Approved");
  expect(signatures[0]?.location).toBe("Kottayam");
});

test("says when the signature covers the whole file", async () => {
  const signatures = await readSignatures(await signed());
  expect(signatures[0]?.coversWholeFile).toBe(true);
  expect(signatures[0]?.bytesAppended).toBeLessThanOrEqual(2);
});

test("and says when something was appended after signing", async () => {
  const signatures = await readSignatures(await signed({ coversAll: false }));
  expect(signatures[0]?.coversWholeFile).toBe(false);
  expect(signatures[0]?.bytesAppended).toBe(200);
});

test("an unsigned document reports none rather than failing", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const bytes = await doc.save();
  expect(await readSignatures(bytes)).toEqual([]);
  expect(await isSigned(bytes)).toBe(false);
});

test("an empty signature field is not a signature", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const field = doc.context.register(
    doc.context.obj({ FT: PDFName.of("Sig"), T: PDFString.of("to.be.signed") }),
  );
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [field] }));
  expect(await readSignatures(await doc.save())).toEqual([]);
});

test("an encrypted document is refused rather than read as a signer's name", async () => {
  // pdf-lib's `ignoreEncryption` parses an encrypted file's structure without
  // decrypting any of it, so reading this one's strings would report the signer
  // as whatever the ciphertext happens to decode to. The trailer's /Encrypt
  // entry is all pdf-lib needs to know it cannot answer.
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const value = doc.context.register(
    doc.context.obj({
      Type: "Sig",
      Name: PDFString.of("The Registrar, IIIT Kottayam"),
      ByteRange: [0, 100, 200, 300],
    }),
  );
  const field = doc.context.register(
    doc.context.obj({ FT: PDFName.of("Sig"), T: PDFString.of("registrar.sig"), V: value }),
  );
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [field], SigFlags: 3 }));
  doc.context.trailerInfo.Encrypt = doc.context.register(
    doc.context.obj({ Filter: PDFName.of("Standard"), V: 2, R: 3, P: -4 }),
  );

  const bytes = await doc.save({ useObjectStreams: false });
  await expect(readSignatures(bytes)).rejects.toThrow(/encrypted/i);
  await expect(isSigned(bytes)).rejects.toThrow(/encrypted/i);
});
