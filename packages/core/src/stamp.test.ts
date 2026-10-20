import { decodePDFRawStream, degrees, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { formatNumber, letters, place, roman, stampPages } from "./stamp.js";

async function pages(count: number, rotation = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([595, 842]);
    if (rotation) page.setRotation(degrees(rotation));
  }
  return doc.save();
}

/** Each page's content stream, decompressed. */
async function streamsOf(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const parts =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => doc.context.lookup(ref))
        : [contents];
    return parts
      .map((stream) =>
        stream instanceof PDFRawStream
          ? new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode())
          : "",
      )
      .join("\n");
  });
}

/**
 * The text drawn into each page, which is where a stamp has to end up — an
 * annotation would neither print nor extract the same way. pdf-lib writes the
 * string as a hex operand, so the hex is what has to be read back.
 */
async function drawnText(bytes: Uint8Array): Promise<string[]> {
  return (await streamsOf(bytes)).map((stream) =>
    [...stream.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)]
      .map(([, hex]) =>
        (hex!.match(/../g) ?? []).map((pair) => String.fromCharCode(parseInt(pair, 16))).join(""),
      )
      .join(" "),
  );
}

describe("number formats", () => {
  test("roman and letters count the way Acrobat's do", () => {
    expect(roman(4)).toBe("iv");
    expect(roman(1989)).toBe("mcmlxxxix");
    expect(letters(1)).toBe("a");
    expect(letters(26)).toBe("z");
    expect(letters(27)).toBe("aa");
  });

  test("formats and zero-padding, which is all Bates numbering is", () => {
    expect(formatNumber(7, "1")).toBe("7");
    expect(formatNumber(7, "I")).toBe("VII");
    expect(formatNumber(7, "A")).toBe("G");
    expect(formatNumber(7, "1", 6)).toBe("000007");
  });
});

describe("placing a stamp on a rotated page", () => {
  // 595 x 842 portrait. A footer sits at the bottom of the page as read, which
  // is a different edge of the sheet for every rotation.
  test("an upright page is left alone", () => {
    expect(place(595, 842, 0, 36, 27)).toEqual({ x: 36, y: 27, angle: 0 });
  });

  test("a quarter turn moves the stamp to the edge the reader sees as the bottom", () => {
    expect(place(595, 842, 90, 36, 27)).toEqual({ x: 568, y: 36, angle: 90 });
    expect(place(595, 842, 270, 36, 27)).toEqual({ x: 27, y: 806, angle: 270 });
    expect(place(595, 842, 180, 36, 27)).toEqual({ x: 559, y: 815, angle: 180 });
  });

  test("rotation is normalised, not trusted", () => {
    expect(place(595, 842, 450, 36, 27)).toEqual(place(595, 842, 90, 36, 27));
    expect(place(595, 842, -90, 36, 27)).toEqual(place(595, 842, 270, 36, 27));
  });
});

describe("stamping", () => {
  test("numbers every page, and leaves the input alone", async () => {
    const input = await pages(3);
    const before = input.slice();
    const out = await stampPages(input, { footer: ["", "Page {n} of {total}", ""] });
    expect(input).toEqual(before);
    expect(out).not.toEqual(input);
    // The stamped document still opens and still has its pages.
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
  });

  test("starts where it is told, and pads for Bates", async () => {
    const out = await stampPages(await pages(2), {
      footer: ["", "", "ACME-{n}"],
      startAt: 500,
      digits: 6,
    });
    const text = await drawnText(out);
    expect(text[0]).toContain("ACME-000500");
    expect(text[1]).toContain("ACME-000501");
  });

  test("stamps only the pages asked for", async () => {
    const out = await stampPages(await pages(4), {
      header: ["Draft", "", ""],
      pages: [1, 2],
    });
    const text = await drawnText(out);
    expect(text.map((page) => page.includes("Draft"))).toEqual([false, true, true, false]);
  });

  test("puts the number where the slot says, in the reader's coordinates", async () => {
    const out = await stampPages(await pages(1, 90), { footer: ["", "Page {n}", ""] });
    expect((await drawnText(out))[0]).toContain("Page 1");

    // A quarter-turned page needs the text turned with it, or the footer runs
    // up the side of the sheet. The turn and the position are both in the text
    // matrix: a, b, c, d, e, f.
    const matrix = /([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) Tm/.exec(
      (await streamsOf(out))[0] ?? "",
    );
    const [, a, b, c, d, e] = matrix!.map(Number);
    expect(a).toBeCloseTo(0, 6);
    expect(b).toBeCloseTo(1, 6);
    expect(c).toBeCloseTo(-1, 6);
    expect(d).toBeCloseTo(0, 6);
    // 36 pt in from the edge the reader sees as the bottom, less the descender.
    expect(e).toBeCloseTo(595 - 33.5, 3);
  });

  test("refuses text the standard fonts cannot draw, before writing anything", async () => {
    await expect(stampPages(await pages(1), { footer: ["", "പേജ് {n}", ""] })).rejects.toThrow(
      /cannot draw/,
    );
  });

  test("refuses an empty stamp and a page that is not there", async () => {
    await expect(stampPages(await pages(1), { footer: ["", "  ", ""] })).rejects.toThrow(
      /nothing to stamp/,
    );
    await expect(
      stampPages(await pages(1), { footer: ["", "{n}", ""], pages: [3] }),
    ).rejects.toThrow(/outside a 1-page document/);
  });
});
