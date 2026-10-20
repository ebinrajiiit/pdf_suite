import { PDFDocument } from "pdf-lib";
import { expect, test } from "vitest";
import { addLink, readDestinations, readLinks, setDestinations } from "./links.js";
import { readAnnotations } from "./read-annots.js";

async function pages(count = 3): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([400, 400]);
  return doc.save();
}

const box = { x: 50, y: 300, w: 200, h: 16 } as const;

test("a link to another page knows which page it goes to", async () => {
  const out = await addLink(await pages(), { page: 0, ...box, target: { page: 2 } });
  const links = await readLinks(out);
  expect(links).toHaveLength(1);
  expect(links[0]?.page).toBe(0);
  expect(links[0]?.target.page).toBe(2);
  expect(links[0]?.w).toBeCloseTo(200, 1);
});

test("a link to a web address keeps the address", async () => {
  const out = await addLink(await pages(1), {
    page: 0,
    ...box,
    target: { url: "https://iiitkottayam.ac.in" },
  });
  expect((await readLinks(out))[0]?.target.url).toBe("https://iiitkottayam.ac.in");
});

test("only http, https and mailto are written", async () => {
  const bytes = await pages(1);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
    await expect(addLink(bytes, { page: 0, ...box, target: { url } })).rejects.toThrow(
      /http, https or mailto/,
    );
  }
  await expect(
    addLink(bytes, { page: 0, ...box, target: { url: "mailto:registrar@example.ac.in" } }),
  ).resolves.toBeDefined();
});

test("a link with nowhere to go, or too small to click, is refused", async () => {
  const bytes = await pages(1);
  await expect(addLink(bytes, { page: 0, ...box, target: {} })).rejects.toThrow(
    /needs somewhere to go/,
  );
  await expect(
    addLink(bytes, { page: 0, x: 1, y: 1, w: 1, h: 1, target: { page: 0 } }),
  ).rejects.toThrow(/big enough to click/);
  await expect(addLink(bytes, { page: 0, ...box, target: { page: 9 } })).rejects.toThrow(
    /outside a 1-page document/,
  );
});

test("links are not comments, and do not turn up in the marks list", async () => {
  const out = await addLink(await pages(2), { page: 0, ...box, target: { page: 1 } });
  // readAnnotations reports every annotation; the Marks panel filters widgets,
  // and a link is a thing a reader follows rather than something someone said.
  expect((await readAnnotations(out)).map((mark) => mark.kind)).toEqual(["link"]);
});

test("named destinations are written sorted, and read back", async () => {
  const named = await setDestinations(await pages(3), [
    { name: "fees", page: 2 },
    { name: "admissions", page: 1 },
  ]);
  const dests = await readDestinations(named);
  // Sorted, because readers binary search a name tree.
  expect(dests.map((dest) => dest.name)).toEqual(["admissions", "fees"]);
  expect(dests.find((dest) => dest.name === "fees")?.page).toBe(2);

  // And a link can point at one by name.
  const linked = await addLink(named, { page: 0, ...box, target: { destination: "fees" } });
  expect((await readLinks(linked))[0]?.target.destination).toBe("fees");
});

test("destinations can be cleared, and a bad one is refused", async () => {
  const named = await setDestinations(await pages(2), [{ name: "top", page: 0 }]);
  expect(await readDestinations(await setDestinations(named, []))).toEqual([]);
  await expect(setDestinations(named, [{ name: "far", page: 8 }])).rejects.toThrow(
    /outside a 2-page document/,
  );
  await expect(setDestinations(named, [{ name: " ", page: 0 }])).rejects.toThrow(/needs a name/);
});
