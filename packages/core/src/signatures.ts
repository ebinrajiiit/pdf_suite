import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * What a document says about its own signatures.
 *
 * An institution receives signed PDFs more often than it sends them, and the
 * question about a received one is whether it is sound and what it covers.
 * This answers the part that can be answered by reading: who the signature
 * says signed it, when, what it covers, and — the one that catches real abuse
 * — whether anything was appended to the file after it was signed.
 *
 * It deliberately does not say the cryptography verifies. Checking the digest
 * and the certificate chain needs a crypto library and a trust store, which
 * ADR 0006 specifies and which is not built. Claiming a document is "valid"
 * when nothing was verified would be worse than saying nothing.
 */

export interface SignatureInfo {
  /** The form field the signature sits in. */
  field: string;
  /** Who the signature says signed it. Not verified against a certificate. */
  signer: string;
  /** When it says it was signed, as written in the file. */
  date: string;
  reason?: string | undefined;
  location?: string | undefined;
  /** Source page the signature appears on, where it appears anywhere. */
  page?: number | undefined;
  /**
   * True when the byte ranges cover the whole file. False means content was
   * appended after signing — which may be another signature, and may not.
   */
  coversWholeFile: boolean;
  /** Bytes after the signed region, for showing how much was appended. */
  bytesAppended: number;
}

export async function readSignatures(input: PdfBytes): Promise<SignatureInfo[]> {
  const doc = await PDFDocument.load(input, { updateMetadata: false, ignoreEncryption: true });
  const form = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(form instanceof PDFDict)) return [];
  const fields = form.lookup(PDFName.of("Fields"));
  if (!(fields instanceof PDFArray)) return [];

  // Which page each signature's widget is on.
  const pageOf = new Map<string, number>();
  doc.getPages().forEach((page, index) => {
    page.node
      .Annots()
      ?.asArray()
      .forEach((ref) => pageOf.set(String(ref), index));
  });

  const out: SignatureInfo[] = [];
  for (const ref of fields.asArray()) {
    const field = doc.context.lookup(ref);
    if (!(field instanceof PDFDict)) continue;
    if (String(field.get(PDFName.of("FT"))) !== "/Sig") continue;

    const value = field.lookup(PDFName.of("V"));
    if (!(value instanceof PDFDict)) continue;

    const range = value.lookup(PDFName.of("ByteRange"));
    const numbers =
      range instanceof PDFArray ? range.asArray().map((entry) => Number(entry.toString())) : [];
    // [start1 length1 start2 length2]: everything except the signature itself.
    const end = numbers.length >= 4 ? (numbers[2] ?? 0) + (numbers[3] ?? 0) : 0;
    const appended = Math.max(0, input.length - end);

    out.push({
      field: textOf(field, "T") || "(unnamed)",
      signer: textOf(value, "Name"),
      date: textOf(value, "M"),
      ...(textOf(value, "Reason") ? { reason: textOf(value, "Reason") } : {}),
      ...(textOf(value, "Location") ? { location: textOf(value, "Location") } : {}),
      ...(pageOf.has(String(ref)) ? { page: pageOf.get(String(ref))! } : {}),
      // A few bytes of trailing whitespace are normal; a kilobyte is not.
      coversWholeFile: appended <= 2,
      bytesAppended: appended,
    });
  }

  return out;
}

function textOf(dict: PDFDict, key: string): string {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : "";
}

/** True when the document has at least one signature field with a signature in it. */
export async function isSigned(input: PdfBytes): Promise<boolean> {
  return (await readSignatures(input)).length > 0;
}
