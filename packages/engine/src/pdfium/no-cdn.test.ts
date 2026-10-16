import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createPdfiumEngine } from "./index.js";

// Comments are allowed to name the CDN constant; code is not.
const code = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

// @embedpdf/pdfium's DEFAULT_PDFIUM_WASM_URL is a jsDelivr URL. Loading it would
// break privacy invariants 2 and 3 (CLAUDE.md §1), so the adapter must always be
// handed the binary from our own bundle.
test("the adapter never references the package's CDN default", () => {
  expect(code).not.toContain("DEFAULT_PDFIUM_WASM_URL");
  expect(code).not.toMatch(/https?:\/\//);
});

test("rejects a cross-origin wasmUrl", async () => {
  const location = { href: "https://app.example/", origin: "https://app.example" };
  Object.defineProperty(globalThis, "location", { value: location, configurable: true });
  try {
    await expect(
      createPdfiumEngine({
        wasmUrl: "https://cdn.jsdelivr.net/npm/@embedpdf/pdfium/dist/pdfium.wasm",
      }),
    ).rejects.toThrow(/same-origin/);
  } finally {
    Reflect.deleteProperty(globalThis, "location");
  }
});
