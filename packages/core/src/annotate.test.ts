import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { annotate, type Annotation } from "./annotate.js";

async function makeDoc(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([400, 400]);
  return doc.save();
}

/** Annotation subtypes on each page of a saved document. */
async function subtypesOf(bytes: Uint8Array): Promise<string[][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const annots = page.node.Annots();
    if (!annots) return [];
    const out: string[] = [];
    for (let i = 0; i < annots.size(); i++) {
      out.push(String(annots.lookup(i, PDFDict).get(PDFName.of("Subtype"))));
    }
    return out;
  });
}

test("writes each kind onto the page it names", async () => {
  const annotations: Annotation[] = [
    { kind: "highlight", page: 0, rects: [{ x: 40, y: 300, w: 200, h: 14 }] },
    { kind: "note", page: 1, x: 100, y: 200, contents: "check this" },
    { kind: "text", page: 1, x: 40, y: 150, w: 180, h: 20, contents: "typed comment" },
  ];
  expect(await subtypesOf(await annotate(await makeDoc(), annotations))).toEqual([
    ["/Highlight"],
    ["/Text", "/FreeText"],
  ]);
});

test("a multi-line highlight becomes one annotation per line", async () => {
  // Each line stays independently removable, which is what deleting "that
  // highlight" means to a reader.
  const marked = await annotate(await makeDoc(1), [
    {
      kind: "highlight",
      page: 0,
      rects: [
        { x: 40, y: 300, w: 200, h: 14 },
        { x: 40, y: 280, w: 160, h: 14 },
      ],
    },
  ]);
  expect((await subtypesOf(marked))[0]).toEqual(["/Highlight", "/Highlight"]);
});

test("keeps annotations already in the document", async () => {
  const once = await annotate(await makeDoc(1), [
    { kind: "note", page: 0, x: 10, y: 20, contents: "first" },
  ]);
  const twice = await annotate(once, [{ kind: "note", page: 0, x: 30, y: 40, contents: "second" }]);
  expect((await subtypesOf(twice))[0]).toEqual(["/Text", "/Text"]);
});

test("does not touch the caller's bytes", async () => {
  const original = await makeDoc(1);
  const before = original.slice();
  await annotate(original, [{ kind: "note", page: 0, x: 10, y: 20, contents: "x" }]);
  expect(original).toEqual(before);
});

test("an empty list returns the input unchanged", async () => {
  const original = await makeDoc(1);
  expect(await annotate(original, [])).toBe(original);
});

test("rejects a page that does not exist rather than dropping the annotation", async () => {
  await expect(
    annotate(await makeDoc(2), [{ kind: "note", page: 5, x: 0, y: 0, contents: "x" }]),
  ).rejects.toThrow(RangeError);
});

test("rejects a highlight with no boxes", async () => {
  await expect(
    annotate(await makeDoc(1), [{ kind: "highlight", page: 0, rects: [] }]),
  ).rejects.toThrow(/at least one box/);
});

test("the text under a highlight survives, because nothing is drawn over it", async () => {
  // A highlight is an annotation, not a filled rectangle in the content stream,
  // so extraction and search still see the words.
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const plain = await doc.save();
  const marked = await annotate(plain, [
    { kind: "highlight", page: 0, rects: [{ x: 0, y: 0, w: 400, h: 400 }] },
  ]);
  const reloaded = await PDFDocument.load(marked);
  // The page's own content is untouched; only the Annots array grew.
  expect(reloaded.getPage(0).node.Annots()?.size()).toBe(1);
});

test("underline and strike-through are their own PDF subtypes", async () => {
  const marked = await annotate(await makeDoc(1), [
    { kind: "underline", page: 0, rects: [{ x: 40, y: 300, w: 200, h: 14 }] },
    { kind: "strike", page: 0, rects: [{ x: 40, y: 280, w: 200, h: 14 }] },
  ]);
  expect((await subtypesOf(marked))[0]).toEqual(["/Underline", "/StrikeOut"]);
});

test("a line over text is opaque, a highlight is not", async () => {
  // A tint has to let the words through; a correction mark should not.
  const doc = await makeDoc(1);
  const rects = [{ x: 40, y: 300, w: 100, h: 12 }];
  const highlight = await PDFDocument.load(
    await annotate(doc, [{ kind: "highlight", page: 0, rects }]),
  );
  const strike = await PDFDocument.load(await annotate(doc, [{ kind: "strike", page: 0, rects }]));
  const opacityOf = (d: PDFDocument) =>
    Number(String(d.getPage(0).node.Annots()!.lookup(0, PDFDict).get(PDFName.of("CA"))));
  expect(opacityOf(highlight)).toBeLessThan(1);
  expect(opacityOf(strike)).toBe(1);
});

test("writes shapes and freehand as their own PDF subtypes", async () => {
  const marked = await annotate(await makeDoc(1), [
    { kind: "square", page: 0, x: 40, y: 300, w: 100, h: 50 },
    { kind: "circle", page: 0, x: 40, y: 200, w: 80, h: 80 },
    {
      kind: "ink",
      page: 0,
      strokes: [
        [
          { x: 40, y: 100 },
          { x: 60, y: 120 },
          { x: 80, y: 100 },
        ],
      ],
    },
  ]);
  expect((await subtypesOf(marked))[0]).toEqual(["/Square", "/Circle", "/Ink"]);
});

test("an ink rectangle contains the strokes plus the pen width", async () => {
  // Too tight a rectangle and viewers clip the ends of the stroke.
  const marked = await annotate(await makeDoc(1), [
    {
      kind: "ink",
      page: 0,
      width: 4,
      strokes: [
        [
          { x: 100, y: 100 },
          { x: 200, y: 150 },
        ],
      ],
    },
  ]);
  const doc = await PDFDocument.load(marked);
  const rect = doc.getPage(0).node.Annots()!.lookup(0, PDFDict).get(PDFName.of("Rect"));
  const values = String(rect).replace(/[[\]]/g, "").trim().split(/\s+/).map(Number);
  expect(values[0]).toBeLessThanOrEqual(96);
  expect(values[1]).toBeLessThanOrEqual(96);
  expect(values[2]).toBeGreaterThanOrEqual(204);
  expect(values[3]).toBeGreaterThanOrEqual(154);
});

test("rejects ink with no strokes or no points", async () => {
  await expect(annotate(await makeDoc(1), [{ kind: "ink", page: 0, strokes: [] }])).rejects.toThrow(
    /at least one stroke/,
  );
  await expect(
    annotate(await makeDoc(1), [{ kind: "ink", page: 0, strokes: [[]] }]),
  ).rejects.toThrow(/at least one point/);
});

test("a colour given for a shape is the colour written", async () => {
  const marked = await annotate(await makeDoc(1), [
    { kind: "square", page: 0, x: 10, y: 10, w: 20, h: 20, color: [0, 0.5, 1] },
  ]);
  const doc = await PDFDocument.load(marked);
  const colour = String(doc.getPage(0).node.Annots()!.lookup(0, PDFDict).get(PDFName.of("C")));
  expect(colour).toContain("0.5");
});

describe("appearances for the kinds no viewer synthesises", () => {
  /** The annotation dictionaries on page 0, as plain objects. */
  async function blankPage(): Promise<Uint8Array> {
    return makeDoc(1);
  }

  async function annotsOf(bytes: Uint8Array) {
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    const annots = page.node.Annots();
    return (annots?.asArray() ?? []).map((ref) => doc.context.lookup(ref) as PDFDict);
  }

  test("a line carries its own appearance stream, sized to its box", async () => {
    const out = await annotate(await blankPage(), [
      { kind: "line", page: 0, x1: 50, y1: 50, x2: 150, y2: 120, arrow: "end" },
    ]);
    const [annot] = await annotsOf(out);
    expect(annot?.get(PDFName.of("Subtype"))?.toString()).toBe("/Line");

    // Without /AP a Line is in the file and invisible in PDFium, which is the
    // renderer this app uses.
    const ap = annot?.lookup(PDFName.of("AP")) as PDFDict | undefined;
    expect(ap).toBeDefined();
    const form = ap?.lookup(PDFName.of("N")) as PDFRawStream | undefined;
    expect(form).toBeDefined();

    // The form's BBox must match the annotation's Rect, or the drawing is
    // scaled into the wrong place.
    const bbox = (form?.dict.lookup(PDFName.of("BBox")) as PDFArray | undefined)
      ?.asArray()
      .map((value) => Number(value.toString()));
    const rect = (annot?.lookup(PDFName.of("Rect")) as PDFArray | undefined)
      ?.asArray()
      .map((value) => Number(value.toString()));
    expect(bbox).toEqual(rect);

    // And the arrowhead is drawn, not merely declared in /LE.
    const ops = new TextDecoder("latin1").decode(decodePDFRawStream(form!).decode());
    expect(ops).toContain(" l S");
    expect(ops).toContain(" f");
  });

  test("a line without an arrow draws no head", async () => {
    const out = await annotate(await blankPage(), [
      { kind: "line", page: 0, x1: 10, y1: 10, x2: 90, y2: 10 },
    ]);
    const [annot] = await annotsOf(out);
    const form = (annot?.lookup(PDFName.of("AP")) as PDFDict).lookup(
      PDFName.of("N"),
    ) as PDFRawStream;
    const ops = new TextDecoder("latin1").decode(decodePDFRawStream(form).decode());
    expect(ops).toContain("m ");
    expect(ops).not.toContain(" f\n");
  });

  test("a stamp is a Stamp with its label drawn in it", async () => {
    const out = await annotate(await blankPage(), [
      { kind: "stamp", page: 0, x: 40, y: 40, w: 160, h: 48, label: "Approved" },
    ]);
    const [annot] = await annotsOf(out);
    expect(annot?.get(PDFName.of("Subtype"))?.toString()).toBe("/Stamp");
    const form = (annot?.lookup(PDFName.of("AP")) as PDFDict).lookup(
      PDFName.of("N"),
    ) as PDFRawStream;
    const ops = new TextDecoder("latin1").decode(decodePDFRawStream(form).decode());
    expect(ops).toContain("(APPROVED) Tj");
    // The label needs a font to be drawn with, in the form's own resources.
    const resources = form.dict.lookup(PDFName.of("Resources")) as PDFDict;
    expect(resources.lookup(PDFName.of("Font"))).toBeDefined();
  });

  test("a stamp label with brackets in it does not break the stream", async () => {
    const out = await annotate(await blankPage(), [
      { kind: "stamp", page: 0, x: 0, y: 0, w: 200, h: 40, label: "Received (copy)" },
    ]);
    const [annot] = await annotsOf(out);
    const form = (annot?.lookup(PDFName.of("AP")) as PDFDict).lookup(
      PDFName.of("N"),
    ) as PDFRawStream;
    const ops = new TextDecoder("latin1").decode(decodePDFRawStream(form).decode());
    expect(ops).toContain("(RECEIVED \\(COPY\\)) Tj");
  });

  test("a picture stamp carries the picture and places it in its box", async () => {
    // The smallest valid PNG: one pixel. What matters here is that it is a real
    // PNG, since pdf-lib parses it rather than taking it on trust.
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const out = await annotate(await blankPage(), [
      { kind: "picture", page: 0, x: 40, y: 50, w: 120, h: 60, image: png, format: "png" },
    ]);
    const [annot] = await annotsOf(out);
    expect(annot?.get(PDFName.of("Subtype"))?.toString()).toBe("/Stamp");

    const form = (annot?.lookup(PDFName.of("AP")) as PDFDict).lookup(
      PDFName.of("N"),
    ) as PDFRawStream;
    const ops = new TextDecoder("latin1").decode(decodePDFRawStream(form).decode());
    // Scaled to the box and moved to its corner: drawing an image is always
    // into the unit square, so the matrix is the whole of where and how big.
    expect(ops).toContain("120 0 0 60 40 50 cm");
    expect(ops).toContain("/Im0 Do");

    // And the picture itself is in the form's resources, where /Im0 resolves.
    const resources = form.dict.lookup(PDFName.of("Resources")) as PDFDict;
    const images = resources.lookup(PDFName.of("XObject")) as PDFDict;
    expect(images.lookup(PDFName.of("Im0"))).toBeDefined();
  });

  test("a signature scales its strokes into the box it is placed in", async () => {
    const strokes = [
      [
        { x: 0, y: 0 },
        { x: 0.5, y: 1 },
        { x: 1, y: 0 },
      ],
    ];
    const out = await annotate(await blankPage(), [
      { kind: "signature", page: 0, x: 100, y: 200, w: 120, h: 40, strokes },
    ]);
    const [annot] = await annotsOf(out);
    expect(annot?.get(PDFName.of("Subtype"))?.toString()).toBe("/Stamp");
    const form = (annot?.lookup(PDFName.of("AP")) as PDFDict).lookup(
      PDFName.of("N"),
    ) as PDFRawStream;
    const ops = new TextDecoder("latin1").decode(decodePDFRawStream(form).decode());
    // 0-1 in, page points out: the first point is the box's own corner.
    expect(ops).toContain("100 200 m");
    expect(ops).toContain("160 240 l");
    expect(ops).toContain("220 200 l");
  });

  test("a signature with no strokes is refused", async () => {
    await expect(
      annotate(await blankPage(), [
        { kind: "signature", page: 0, x: 0, y: 0, w: 10, h: 10, strokes: [] },
      ]),
    ).rejects.toThrow(/at least one stroke/);
  });
});

describe("the shapes a reviewer rings things with", () => {
  async function one(annotation: Annotation) {
    const out = await annotate(await makeDoc(1), [annotation]);
    const doc = await PDFDocument.load(out);
    const annots = doc.getPage(0).node.Annots();
    const annot = doc.context.lookup(annots!.get(0)) as PDFDict;
    const form = (annot.lookup(PDFName.of("AP")) as PDFDict).lookup(
      PDFName.of("N"),
    ) as PDFRawStream;
    return {
      annot,
      subtype: annot.get(PDFName.of("Subtype"))?.toString(),
      ops: new TextDecoder("latin1").decode(decodePDFRawStream(form).decode()),
    };
  }

  const triangle = [
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 150, y: 200 },
  ];

  test("a polygon closes its path; a polyline does not", async () => {
    const closed = await one({ kind: "polygon", page: 0, points: triangle });
    expect(closed.subtype).toBe("/Polygon");
    expect(closed.ops).toContain(" h S");
    expect(closed.annot.lookup(PDFName.of("Vertices"), PDFArray).size()).toBe(6);

    const open = await one({ kind: "polyline", page: 0, points: triangle });
    expect(open.subtype).toBe("/PolyLine");
    expect(open.ops).not.toContain(" h S");
  });

  test("a cloud draws its bumps, and says it is one", async () => {
    const cloud = await one({ kind: "polygon", page: 0, points: triangle, cloud: true });
    expect(cloud.subtype).toBe("/Polygon");
    // Curves, not straight segments: a cloud is arcs along each edge.
    expect(cloud.ops).toContain(" c\n");
    // And the border effect, for a reader that draws its own appearance.
    const effect = cloud.annot.lookup(PDFName.of("BE"), PDFDict);
    expect(effect.get(PDFName.of("S"))?.toString()).toBe("/C");
  });

  test("too few points is refused rather than drawn as nothing", async () => {
    await expect(
      annotate(await makeDoc(1), [{ kind: "polygon", page: 0, points: [{ x: 1, y: 1 }] }]),
    ).rejects.toThrow(/at least two points/);
  });

  test("a callout carries its line, its words, and the point it indicates", async () => {
    const callout = await one({
      kind: "callout",
      page: 0,
      x: 180,
      y: 260,
      w: 160,
      h: 50,
      contents: "This date is wrong",
      tipX: 90,
      tipY: 120,
    });
    expect(callout.subtype).toBe("/FreeText");
    // The callout line: tip, knee, and where it meets the box.
    expect(callout.annot.lookup(PDFName.of("CL"), PDFArray).size()).toBe(6);
    expect(callout.annot.get(PDFName.of("IT"))?.toString()).toBe("/FreeTextCallout");
    expect(callout.ops).toContain("(This date is wrong) Tj");
  });

  test("a caret points at where something is missing", async () => {
    const caret = await one({
      kind: "caret",
      page: 0,
      x: 120,
      y: 300,
      contents: "insert: and the fee",
    });
    expect(caret.subtype).toBe("/Caret");
    // A filled triangle, which is what a caret is.
    expect(caret.ops).toContain(" f");
  });
});

test("a measured line says how long it is, and is marked as a dimension", async () => {
  const out = await annotate(await makeDoc(1), [
    {
      kind: "line",
      page: 0,
      x1: 50,
      y1: 100,
      x2: 194,
      y2: 100,
      arrow: "both",
      measurement: "2.00 in",
    },
  ]);
  const doc = await PDFDocument.load(out);
  const annot = doc.context.lookup(doc.getPage(0).node.Annots()!.get(0)) as PDFDict;
  expect(annot.get(PDFName.of("IT"))?.toString()).toBe("/LineDimension");
  expect(String(annot.lookup(PDFName.of("Contents")))).toContain("2.00 in");

  const form = (annot.lookup(PDFName.of("AP")) as PDFDict).lookup(PDFName.of("N")) as PDFRawStream;
  const ops = new TextDecoder("latin1").decode(decodePDFRawStream(form).decode());
  // Drawn on the page, not only recorded in the dictionary.
  expect(ops).toContain("(2.00 in) Tj");
  // On a plate, or it disappears into the drawing underneath.
  expect(ops).toContain("1 1 1 rg");
});

test("a measured area carries its number too", async () => {
  const out = await annotate(await makeDoc(1), [
    {
      kind: "polygon",
      page: 0,
      points: [
        { x: 0, y: 0 },
        { x: 72, y: 0 },
        { x: 72, y: 72 },
      ],
      measurement: "0.50 in²",
    },
  ]);
  const doc = await PDFDocument.load(out);
  const annot = doc.context.lookup(doc.getPage(0).node.Annots()!.get(0)) as PDFDict;
  expect(annot.get(PDFName.of("IT"))?.toString()).toBe("/PolygonDimension");
});
