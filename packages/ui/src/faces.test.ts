import { expect, test } from "vitest";
import { STANDARD_FONTS } from "@pdf-suite/engine/pdfium";
import { FACES } from "./TextEditLayer.js";

// The editor offers these faces; the engine decides which it accepts. They are
// written out separately so the web bundle does not import the PDFium adapter
// for nine strings, which makes this test the thing that keeps them in step.
test("every face the format bar offers is one the engine will accept", () => {
  expect(FACES.map((face) => face.name)).toEqual([...STANDARD_FONTS]);
});
