import { expect, test } from "vitest";
import { naming } from "./index.js";

test("a crash inside PDFium says which call crashed", async () => {
  const trap = new WebAssembly.RuntimeError("Unreachable code should not be executed");
  const heap = { HEAPU8: new Uint8Array(4) };
  const module = {
    pdfium: heap,
    FPDF_LoadPage: () => {
      throw trap;
    },
    FPDF_GetPageCount: () => 7,
  };

  const named = naming(module as never) as unknown as {
    pdfium: typeof heap;
    FPDF_LoadPage: () => void;
    FPDF_GetPageCount: () => number;
  };

  // The heap and anything else that is not a function passes straight through.
  expect(named.pdfium).toBe(heap);
  expect(named.FPDF_GetPageCount()).toBe(7);

  try {
    named.FPDF_LoadPage();
    expect.unreachable("the trap should have been re-thrown");
  } catch (err) {
    const error = err as Error;
    expect(error.message).toContain("FPDF_LoadPage");
    // The original text is kept, so a bug report still carries what wasm said.
    expect(error.message).toContain("Unreachable code should not be executed");
    expect(error.cause).toBe(trap);
  }
});

test("an ordinary error from PDFium is passed through untouched", async () => {
  const mine = new RangeError("page 9 out of range");
  const named = naming({
    pdfium: {},
    FPDF_LoadPage: () => {
      throw mine;
    },
  } as never) as unknown as { FPDF_LoadPage: () => void };
  expect(() => named.FPDF_LoadPage()).toThrow(mine);
});
