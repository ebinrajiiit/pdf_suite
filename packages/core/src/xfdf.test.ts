import { PDFDocument } from "pdf-lib";
import { expect, test } from "vitest";
import { annotate } from "./annotate.js";
import { readAnnotations } from "./read-annots.js";
import { asAnnotations, fromXfdf, toXfdf } from "./xfdf.js";

async function marked(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  return annotate(await doc.save(), [
    {
      kind: "note",
      page: 0,
      x: 40,
      y: 320,
      contents: "Check <these> & those",
      author: "A Reviewer",
    },
    { kind: "square", page: 0, x: 20, y: 20, w: 90, h: 40, color: [1, 0, 0] },
    { kind: "highlight", page: 0, rects: [{ x: 50, y: 200, w: 120, h: 14 }] },
  ]);
}

test("writes the marks as XFDF, with the characters XML would choke on escaped", async () => {
  const xml = toXfdf(await readAnnotations(await marked()), "circular.pdf");
  expect(xml).toContain('<?xml version="1.0"');
  expect(xml).toContain('xmlns="http://ns.adobe.com/xfdf/"');
  expect(xml).toContain('<f href="circular.pdf"/>');
  expect(xml).toContain("Check &lt;these&gt; &amp; those");
  expect(xml).toContain('title="A Reviewer"');
  expect(xml).toContain('color="#ff0000"');
});

test("reads back what it wrote, in the same places", async () => {
  const before = await readAnnotations(await marked());
  const { marks, skipped } = fromXfdf(toXfdf(before));
  expect(skipped).toBe(0);
  expect(marks).toHaveLength(before.length);

  const note = marks.find((mark) => mark.kind === "text")!;
  expect(note.contents).toBe("Check <these> & those");
  expect(note.author).toBe("A Reviewer");

  const box = marks.find((mark) => mark.kind === "square")!;
  expect(box.rect.x).toBeCloseTo(20, 1);
  expect(box.rect.w).toBeCloseTo(90, 1);
  expect(box.colour?.[0]).toBeCloseTo(1, 2);
});

test("imported marks become annotations that can be written into a document", async () => {
  const { marks } = fromXfdf(toXfdf(await readAnnotations(await marked())));
  const { annotations, dropped } = asAnnotations(marks);
  expect(dropped).toBe(0);

  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const written = await annotate(await doc.save(), annotations);
  const back = await readAnnotations(written);
  expect(back.map((mark) => mark.kind).sort()).toEqual(["highlight", "square", "text"]);
});

test("reads an XFDF file written by something else", async () => {
  // The shape Acrobat writes: quads on a highlight, a title, a colour.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
<annots>
<highlight page="1" rect="72.0,700.0,300.0,715.0" color="#ffff00" title="Registrar"
 coords="72,715,300,715,72,700,300,700"><contents>Fees clause</contents></highlight>
<squiggly page="0" rect="10,10,50,20"/>
</annots>
</xfdf>`;
  const { marks, skipped } = fromXfdf(xml);
  expect(skipped).toBe(0);
  expect(marks).toHaveLength(2);

  const highlight = marks[0]!;
  expect(highlight.page).toBe(1);
  expect(highlight.contents).toBe("Fees clause");
  expect(highlight.coords).toHaveLength(8);

  // The squiggly cannot be drawn here, so it is dropped and counted rather
  // than turned into something the reviewer did not write.
  const { annotations, dropped } = asAnnotations(marks);
  expect(dropped).toBe(1);
  expect(annotations).toHaveLength(1);
  // Quads became one box per line, not one box over the whole thing.
  expect(annotations[0]).toMatchObject({ kind: "highlight", page: 1 });
});

test("rubbish in is counted, not guessed at", () => {
  const { marks, skipped } = fromXfdf(
    `<xfdf><annots><square page="x" rect="1,2,3,4"/><circle page="0" rect="bad"/></annots></xfdf>`,
  );
  expect(marks).toHaveLength(0);
  expect(skipped).toBe(2);
});
