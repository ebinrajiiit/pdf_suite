// Every op: bytes in, new bytes out. Never mutate the caller's buffer (CLAUDE.md §4).
// Implementations land in Phase 1 on pdf-lib + qpdf.wasm.

export type PdfBytes = Uint8Array;

export declare function merge(inputs: PdfBytes[]): Promise<PdfBytes>;
export declare function split(input: PdfBytes, ranges: [number, number][]): Promise<PdfBytes[]>;
export declare function reorder(input: PdfBytes, order: number[]): Promise<PdfBytes>;
export declare function rotate(
  input: PdfBytes,
  pages: number[],
  degrees: 90 | 180 | 270,
): Promise<PdfBytes>;
