import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { expect, test } from "vitest";
import { checkAccessibility, fixAccessibility } from "./accessibility.js";

async function plain(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  return doc.save();
}

const idsOf = (issues: { id: string }[]) => issues.map((issue) => issue.id);

test("names what is wrong with an ordinary converted document", async () => {
  const issues = await checkAccessibility(await plain());
  expect(idsOf(issues)).toContain("title");
  expect(idsOf(issues)).toContain("language");
  expect(idsOf(issues)).toContain("tagged");
  // Tagging is reported as something this cannot fix, rather than pretended at.
  expect(issues.find((issue) => issue.id === "tagged")?.fixable).toBe(false);
});

test("a scan with no text layer is a failure, not a warning", async () => {
  const issues = await checkAccessibility(await plain(), { pagesWithoutText: [0, 1] });
  const scanned = issues.find((issue) => issue.id === "scanned");
  expect(scanned?.severity).toBe("fail");
  expect(scanned?.summary).toContain("2 pages");
});

test("fixes the title, the language and the window title, and nothing else", async () => {
  const fixed = await fixAccessibility(await plain(), {
    title: "Minutes of the Academic Council",
    language: "en-IN",
  });

  const doc = await PDFDocument.load(fixed);
  expect(doc.getTitle()).toBe("Minutes of the Academic Council");
  expect(doc.catalog.lookup(PDFName.of("Lang"))?.toString()).toContain("en-IN");
  const preferences = doc.catalog.lookup(PDFName.of("ViewerPreferences"), PDFDict);
  expect(preferences.get(PDFName.of("DisplayDocTitle"))?.toString()).toBe("true");

  const issues = await checkAccessibility(fixed);
  expect(idsOf(issues)).not.toContain("title");
  expect(idsOf(issues)).not.toContain("language");
  expect(idsOf(issues)).not.toContain("displayTitle");
  // Still untagged, and still saying so.
  expect(idsOf(issues)).toContain("tagged");
});

test("a document that already has a title keeps it", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.setTitle("The real title");
  const fixed = await fixAccessibility(await doc.save(), { title: "Something else" });
  expect((await PDFDocument.load(fixed)).getTitle()).toBe("The real title");
});

test("pictures are only reported once there is nothing to describe them with", async () => {
  const withImages = await checkAccessibility(await plain(), { imageCount: 3 });
  expect(idsOf(withImages)).toContain("alt");
  const none = await checkAccessibility(await plain(), { imageCount: 0 });
  expect(idsOf(none)).not.toContain("alt");
});
