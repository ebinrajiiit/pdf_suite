import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { expect, test } from "vitest";
import { readLayers, setLayerVisibility } from "./layers.js";

/** A document with three layers, as a drawing arrives with. */
async function layered(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const groups = ["Structural", "Electrical", "Plumbing"].map((name) =>
    doc.context.register(doc.context.obj({ Type: "OCG", Name: PDFString.of(name) })),
  );
  doc.catalog.set(
    PDFName.of("OCProperties"),
    doc.context.obj({ OCGs: groups, D: doc.context.obj({ OFF: [groups[2]!] }) }),
  );
  return doc.save();
}

test("lists the layers and which are on", async () => {
  const layers = await readLayers(await layered());
  expect(layers.map((layer) => layer.name)).toEqual(["Structural", "Electrical", "Plumbing"]);
  expect(layers.map((layer) => layer.visible)).toEqual([true, true, false]);
});

test("a document without layers lists none rather than failing", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  expect(await readLayers(await doc.save())).toEqual([]);
});

test("turns one off and another on, leaving the rest as they were", async () => {
  const bytes = await layered();
  const before = await readLayers(bytes);

  const changed = await setLayerVisibility(bytes, {
    [before[1]!.id]: false,
    [before[2]!.id]: true,
  });

  const after = await readLayers(changed);
  expect(after.map((layer) => layer.visible)).toEqual([true, false, true]);
});

test("turning everything on removes the off list entirely", async () => {
  const bytes = await layered();
  const all = Object.fromEntries((await readLayers(bytes)).map((layer) => [layer.id, true]));
  const changed = await setLayerVisibility(bytes, all);
  expect((await readLayers(changed)).every((layer) => layer.visible)).toBe(true);
});

test("a layer that is not there, or a document without any, is refused", async () => {
  const bytes = await layered();
  await expect(setLayerVisibility(bytes, { "99 0 R": false })).rejects.toThrow(/no layer/);

  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  await expect(setLayerVisibility(await doc.save(), {})).rejects.toThrow(/no layers/);
});
