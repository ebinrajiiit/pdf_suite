import {
  CancelledError,
  type AccessibilityIssue,
  type Annotation,
  type Attachment,
  type Bookmark,
  type Box,
  type DocumentDiff,
  type DocumentInfo,
  type EncryptOptions,
  type NewField,
  type PageLabelRange,
  type WatermarkOptions,
  type FieldValues,
  type OcrAssets,
  type EditableText,
  type FindRequest,
  type Found,
  type ImageEdit,
  type ImageEditResult,
  type PageImage,
  type Link,
  type LinkTarget,
  type RedactArea,
  type RedactionMark,
  type Reply,
  type RedactionResult,
  type TextEdit,
  type TextEditResult,
  type DocumentProperties,
  type SanitiseOptions,
  type SanitiseReport,
  type SearchHit,
  type StandardIssue,
  type StampOptions,
  type TextRun,
  type TerminalResponse,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.js";

/** Omit over a union has to distribute, or it collapses to the common keys only. */
type RequestBody = WorkerRequest extends infer T
  ? T extends { id: number }
    ? Omit<T, "id">
    : never
  : never;

/** Progress callback for the operations that report it (currently merge). */
export type OnProgress = (done: number, total: number) => void;

export interface PdfWorkerClient {
  init(wasmBinary: ArrayBuffer, qpdfWasmUrl: string): Promise<void>;
  open(bytes: ArrayBuffer): Promise<DocumentInfo>;
  /** Retries a document that raised PasswordRequiredError, with its password. */
  unlock(password: string): Promise<DocumentInfo>;
  merge(
    inputs: ArrayBuffer[],
    order: number[],
    annotations: Annotation[],
    onProgress?: OnProgress,
  ): Promise<DocumentInfo>;
  render(page: number, scale: number): Promise<ImageBitmap>;
  /** Extracted text for one source page, for snapping highlights to lines. */
  pageText(page: number): Promise<TextRun[]>;
  rotate(
    positions: number[],
    by: 90 | 180 | 270,
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** Recompresses the document, which reopens it. */
  compress(order: number[], annotations: Annotation[]): Promise<DocumentInfo>;
  /** Writes form values, optionally flattening them, and reopens the document. */
  fillForm(
    values: FieldValues,
    flatten: boolean,
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** Checks the document against PDF/A, or against what a press needs. */
  checkStandard(
    standard: "pdfa" | "print",
    order: number[],
    annotations: Annotation[],
  ): Promise<StandardIssue[]>;
  /** Sets the trim box, inset by the bleed given. */
  setTrimBox(bleed: number, order: number[], annotations: Annotation[]): Promise<DocumentInfo>;
  /** Makes the document present as a portfolio. */
  makePortfolio(order: number[], annotations: Annotation[]): Promise<DocumentInfo>;
  /** Writes redaction marks, destroying nothing. */
  markRedactions(
    marks: RedactionMark[],
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** Applies every mark waiting in the document, and checks the text is gone. */
  applyRedactions(
    order: number[],
    annotations: Annotation[],
  ): Promise<{
    info: DocumentInfo;
    removed: Record<number, number>;
    verified: boolean;
    leftovers: RedactionResult["leftovers"];
  }>;
  /** Turns layers on and off. */
  setLayers(
    visibility: Record<string, boolean>,
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** Every link in the document. */
  links(order: number[], annotations: Annotation[]): Promise<Link[]>;
  /** Adds a link box to a page. */
  addLink(
    link: { page: number; x: number; y: number; w: number; h: number; target: LinkTarget },
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** The document's marks as an XFDF file. */
  exportXfdf(name: string, order: number[], annotations: Annotation[]): Promise<string>;
  /** Imports marks from an XFDF file. */
  importXfdf(
    xml: string,
    order: number[],
    annotations: Annotation[],
  ): Promise<{ info: DocumentInfo; added: number; dropped: number; skipped: number }>;
  /** Answers a mark, or sets its review state. */
  reply(reply: Reply, order: number[], annotations: Annotation[]): Promise<DocumentInfo>;
  /** Removes a mark the document already carried. */
  deleteMark(
    page: number,
    index: number,
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** Compares another document with this one and reports what differs. */
  compare(
    other: ArrayBuffer,
    order: number[],
    annotations: Annotation[],
    onProgress?: OnProgress,
  ): Promise<DocumentDiff>;
  /** Files carried inside the document. */
  attachments(order: number[], annotations: Annotation[]): Promise<Attachment[]>;
  attach(
    file: { name: string; bytes: ArrayBuffer; type?: string | undefined },
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  readAttachment(name: string, order: number[], annotations: Annotation[]): Promise<ArrayBuffer>;
  removeAttachment(name: string, order: number[], annotations: Annotation[]): Promise<DocumentInfo>;
  /** Adds a form field to a page. */
  addField(field: NewField, order: number[], annotations: Annotation[]): Promise<DocumentInfo>;
  /** Removes a form field by name. */
  removeField(name: string, order: number[], annotations: Annotation[]): Promise<DocumentInfo>;
  /** The images on one source page. */
  images(page: number, order: number[], annotations: Annotation[]): Promise<PageImage[]>;
  /** Moves, resizes or removes images, reopening the document. */
  editImages(
    edits: ImageEdit[],
    order: number[],
    annotations: Annotation[],
  ): Promise<{ info: DocumentInfo; applied: number; rejected: ImageEditResult["rejected"] }>;
  /** The paragraphs on one source page that can be edited in place. */
  editableText(page: number, order: number[], annotations: Annotation[]): Promise<EditableText[]>;
  /**
   * Replaces the text of the named paragraphs, re-wrapping each to its own
   * width, and reopens the document. The reply reports font substitutions and
   * lines the blocks did not have before, both of which the user must be told
   * about rather than left to notice.
   */
  editText(
    edits: TextEdit[],
    order: number[],
    annotations: Annotation[],
  ): Promise<{
    info: DocumentInfo;
    applied: number;
    substituted: TextEditResult["substituted"];
    addedLines: number;
    rejected: TextEditResult["rejected"];
  }>;
  /** Writes the document's title, author, subject and keywords. */
  setProperties(
    properties: Partial<DocumentProperties>,
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** Draws headers, footers and page numbers into the pages. */
  stamp(options: StampOptions, order: number[], annotations: Annotation[]): Promise<DocumentInfo>;
  /**
   * Steps back to the previous version of the document, or forward again. The
   * current page order and marks are sent so that the opposite step can restore
   * them; the reply carries the ones belonging to the version restored.
   */
  undo(
    order: number[],
    annotations: Annotation[],
  ): Promise<{ info: DocumentInfo; order: number[]; annotations: Annotation[] }>;
  redo(
    order: number[],
    annotations: Annotation[],
  ): Promise<{ info: DocumentInfo; order: number[]; annotations: Annotation[] }>;
  /** Replaces the document's bookmarks. */
  setOutline(
    bookmarks: Bookmark[],
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** Checks whether a screen reader could read this document. Changes nothing. */
  checkAccessible(order: number[], annotations: Annotation[]): Promise<AccessibilityIssue[]>;
  /** Sets the title, the language and the window-title flag. */
  fixAccessible(
    title: string,
    language: string,
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** The document's text in display order, for saving as a plain text file. */
  toText(order: number[], onProgress?: OnProgress): Promise<string>;
  /** Crops pages, or puts the whole page back when the box is null. */
  crop(
    box: Box | null,
    pages: number[] | undefined,
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** Draws a watermark across pages. */
  watermark(
    options: WatermarkOptions,
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** Sets what the viewer's page box shows. */
  pageLabels(
    ranges: PageLabelRange[],
    order: number[],
    annotations: Annotation[],
  ): Promise<DocumentInfo>;
  /** Reports what the document carries but does not show, changing nothing. */
  findHidden(order: number[], annotations: Annotation[]): Promise<SanitiseReport>;
  /** Removes it, and says what went. */
  sanitise(
    options: SanitiseOptions,
    order: number[],
    annotations: Annotation[],
  ): Promise<{ info: DocumentInfo; removed: SanitiseReport; wasClean: boolean }>;
  /** Finds personal numbers or words across the document, without changing it. */
  findPattern(request: FindRequest, order: number[], annotations: Annotation[]): Promise<Found>;
  /**
   * Removes the content inside the given areas. The reply says how many page
   * objects went and whether re-reading the result found any text left inside
   * them — a false `verified` must be shown to the user, not swallowed.
   */
  redact(
    areas: RedactArea[],
    order: number[],
    annotations: Annotation[],
  ): Promise<{
    info: DocumentInfo;
    removed: Record<number, number>;
    verified: boolean;
    leftovers: RedactionResult["leftovers"];
  }>;
  /**
   * Sets the password applied when saving, or null to remove protection, with
   * what a reader may do without the owner password.
   */
  protect(password: string | null, allow?: EncryptOptions["allow"]): Promise<DocumentInfo>;
  /** Searches the given display order, reporting progress per page. */
  search(
    query: string,
    order: number[],
    onProgress?: OnProgress,
  ): Promise<{ hits: SearchHit[]; truncated: boolean }>;
  save(order: number[], annotations: Annotation[]): Promise<ArrayBuffer>;
  /** Splits into parts starting at the given display positions. */
  split(at: number[], order: number[], annotations: Annotation[]): Promise<ArrayBuffer[]>;
  /** Builds a document from images and opens it. */
  fromImages(images: { bytes: ArrayBuffer; type: string }[]): Promise<DocumentInfo>;
  /**
   * Makes the given display positions searchable. Pages that already have text
   * are left alone and counted as skipped.
   */
  ocr(
    positions: number[],
    order: number[],
    annotations: Annotation[],
    languages: string[],
    assets: OcrAssets,
    despeckle: boolean,
    onProgress?: OnProgress,
  ): Promise<{ info: DocumentInfo; recognised: number; skipped: number }>;
  /** Renders the given display positions to PNG. */
  toImages(
    positions: number[],
    order: number[],
    scale: number,
    onProgress?: OnProgress,
  ): Promise<{ position: number; bytes: ArrayBuffer }[]>;
  close(): Promise<void>;
  /** Abandons the operation the returned handle identifies. */
  cancel(id: number): void;
  terminate(): void;
}

/**
 * The worker is addressed by URL rather than by import so bundlers emit it as a
 * worker chunk; it stays same-origin, which `worker-src 'self' blob:` requires.
 */
export function createPdfWorker(): Worker {
  // The .ts extension is deliberate: these packages are consumed as source, so
  // the bundler has to see the real file to emit it as a worker chunk.
  return new Worker(new URL("./pdf.worker.ts", import.meta.url), {
    type: "module",
    name: "pdf-suite",
  });
}

export function createPdfWorkerClient(worker: Worker = createPdfWorker()): PdfWorkerClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (r: TerminalResponse) => void; reject: (e: Error) => void; onProgress?: OnProgress }
  >();

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    if (response.kind === "progress") {
      entry.onProgress?.(response.done, response.total);
      return;
    }
    pending.delete(response.id);
    if (response.kind === "error") {
      const error = new Error(response.message);
      error.name = response.name;
      entry.reject(error);
    } else if (response.kind === "cancelled") {
      entry.reject(new CancelledError());
    } else {
      entry.resolve(response);
    }
  };

  worker.onerror = (event) => {
    const error = new Error(`worker failed: ${event.message}`);
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  };

  function send(
    request: RequestBody,
    transfer: Transferable[] = [],
    onProgress?: OnProgress,
  ): Promise<TerminalResponse> {
    const id = nextId++;
    return new Promise<TerminalResponse>((resolve, reject) => {
      pending.set(id, onProgress ? { resolve, reject, onProgress } : { resolve, reject });
      worker.postMessage({ ...request, id } as WorkerRequest, transfer);
    });
  }

  /** Narrows a reply to the kind the caller expects, so a stray kind is a clear error. */
  function expect<K extends TerminalResponse["kind"]>(
    response: TerminalResponse,
    kind: K,
  ): Extract<TerminalResponse, { kind: K }> {
    if (response.kind !== kind)
      throw new Error(`worker replied ${response.kind}, expected ${kind}`);
    return response as Extract<TerminalResponse, { kind: K }>;
  }

  return {
    async init(wasmBinary, qpdfWasmUrl) {
      expect(await send({ kind: "init", wasmBinary, qpdfWasmUrl }, [wasmBinary]), "ready");
    },
    async open(bytes) {
      return expect(await send({ kind: "open", bytes }, [bytes]), "document").info;
    },
    async unlock(password) {
      return expect(await send({ kind: "unlock", password }), "document").info;
    },
    async merge(inputs, order, annotations, onProgress) {
      return expect(
        await send({ kind: "merge", inputs, order, annotations }, inputs, onProgress),
        "document",
      ).info;
    },
    async render(page, scale) {
      return expect(await send({ kind: "render", page, scale }), "bitmap").bitmap;
    },
    async pageText(page) {
      return expect(await send({ kind: "text", page }), "runs").runs;
    },
    async rotate(positions, by, order, annotations) {
      return expect(await send({ kind: "rotate", positions, by, order, annotations }), "document")
        .info;
    },
    async compress(order, annotations) {
      return expect(await send({ kind: "compress", order, annotations }), "document").info;
    },
    async fillForm(values, flatten, order, annotations) {
      return expect(
        await send({ kind: "fillForm", values, flatten, order, annotations }),
        "document",
      ).info;
    },
    async checkStandard(standard, order, annotations) {
      return expect(await send({ kind: "checkStandard", standard, order, annotations }), "standard")
        .issues;
    },
    async setTrimBox(bleed, order, annotations) {
      return expect(await send({ kind: "setTrimBox", bleed, order, annotations }), "document").info;
    },
    async makePortfolio(order, annotations) {
      return expect(await send({ kind: "makePortfolio", order, annotations }), "document").info;
    },
    async markRedactions(marks, order, annotations) {
      return expect(await send({ kind: "markRedactions", marks, order, annotations }), "document")
        .info;
    },
    async applyRedactions(order, annotations) {
      const reply = expect(await send({ kind: "applyRedactions", order, annotations }), "redacted");
      return {
        info: reply.info,
        removed: reply.removed,
        verified: reply.verified,
        leftovers: reply.leftovers,
      };
    },
    async setLayers(visibility, order, annotations) {
      return expect(await send({ kind: "setLayers", visibility, order, annotations }), "document")
        .info;
    },
    async links(order, annotations) {
      return expect(await send({ kind: "links", order, annotations }), "links").links;
    },
    async addLink(link, order, annotations) {
      return expect(await send({ kind: "addLink", link, order, annotations }), "document").info;
    },
    async exportXfdf(name, order, annotations) {
      return expect(await send({ kind: "exportXfdf", name, order, annotations }), "xfdf").xml;
    },
    async importXfdf(xml, order, annotations) {
      const reply = expect(await send({ kind: "importXfdf", xml, order, annotations }), "imported");
      return {
        info: reply.info,
        added: reply.added,
        dropped: reply.dropped,
        skipped: reply.skipped,
      };
    },
    async reply(reply, order, annotations) {
      return expect(await send({ kind: "reply", reply, order, annotations }), "document").info;
    },
    async deleteMark(page, index, order, annotations) {
      return expect(await send({ kind: "deleteMark", page, index, order, annotations }), "document")
        .info;
    },
    async compare(other, order, annotations, onProgress) {
      return expect(
        await send({ kind: "compare", other, order, annotations }, [other], onProgress),
        "compared",
      ).diff;
    },
    async attachments(order, annotations) {
      return expect(await send({ kind: "attachments", order, annotations }), "attached").files;
    },
    async attach(file, order, annotations) {
      return expect(
        await send({ kind: "attach", file, order, annotations }, [file.bytes]),
        "document",
      ).info;
    },
    async readAttachment(name, order, annotations) {
      return expect(await send({ kind: "readAttachment", name, order, annotations }), "attachment")
        .bytes;
    },
    async removeAttachment(name, order, annotations) {
      return expect(await send({ kind: "removeAttachment", name, order, annotations }), "document")
        .info;
    },
    async addField(field, order, annotations) {
      return expect(await send({ kind: "addField", field, order, annotations }), "document").info;
    },
    async removeField(name, order, annotations) {
      return expect(await send({ kind: "removeField", name, order, annotations }), "document").info;
    },
    async images(page, order, annotations) {
      return expect(await send({ kind: "images", page, order, annotations }), "pageImages").images;
    },
    async editImages(edits, order, annotations) {
      const reply = expect(
        await send({ kind: "editImages", edits, order, annotations }),
        "imagesEdited",
      );
      return { info: reply.info, applied: reply.applied, rejected: reply.rejected };
    },
    async editableText(page, order, annotations) {
      return expect(await send({ kind: "editableText", page, order, annotations }), "editable")
        .runs;
    },
    async editText(edits, order, annotations) {
      const reply = expect(await send({ kind: "editText", edits, order, annotations }), "edited");
      return {
        info: reply.info,
        applied: reply.applied,
        substituted: reply.substituted,
        addedLines: reply.addedLines,
        rejected: reply.rejected,
      };
    },
    async setProperties(properties, order, annotations) {
      return expect(
        await send({ kind: "setProperties", properties, order, annotations }),
        "document",
      ).info;
    },
    async stamp(options, order, annotations) {
      return expect(await send({ kind: "stamp", options, order, annotations }), "document").info;
    },
    async undo(order, annotations) {
      const reply = expect(await send({ kind: "undo", order, annotations }), "restored");
      return { info: reply.info, order: reply.order, annotations: reply.annotations };
    },
    async redo(order, annotations) {
      const reply = expect(await send({ kind: "redo", order, annotations }), "restored");
      return { info: reply.info, order: reply.order, annotations: reply.annotations };
    },
    async setOutline(bookmarks, order, annotations) {
      return expect(await send({ kind: "setOutline", bookmarks, order, annotations }), "document")
        .info;
    },
    async toText(order, onProgress) {
      return expect(await send({ kind: "toText", order }, [], onProgress), "text").text;
    },
    async crop(box, pages, order, annotations) {
      return expect(
        await send({ kind: "crop", box, ...(pages ? { pages } : {}), order, annotations }),
        "document",
      ).info;
    },
    async watermark(options, order, annotations) {
      return expect(await send({ kind: "watermark", options, order, annotations }), "document")
        .info;
    },
    async pageLabels(ranges, order, annotations) {
      return expect(await send({ kind: "pageLabels", ranges, order, annotations }), "document")
        .info;
    },
    async checkAccessible(order, annotations) {
      return expect(await send({ kind: "checkAccessible", order, annotations }), "accessibility")
        .issues;
    },
    async fixAccessible(title, language, order, annotations) {
      return expect(
        await send({ kind: "fixAccessible", title, language, order, annotations }),
        "document",
      ).info;
    },
    async findHidden(order, annotations) {
      return expect(await send({ kind: "findHidden", order, annotations }), "hidden").report;
    },
    async sanitise(options, order, annotations) {
      const reply = expect(
        await send({ kind: "sanitise", options, order, annotations }),
        "sanitised",
      );
      return { info: reply.info, removed: reply.removed, wasClean: reply.wasClean };
    },
    async findPattern(request, order, annotations) {
      return expect(await send({ kind: "findPattern", request, order, annotations }), "found")
        .found;
    },
    async redact(areas, order, annotations) {
      const reply = expect(await send({ kind: "redact", areas, order, annotations }), "redacted");
      return {
        info: reply.info,
        removed: reply.removed,
        verified: reply.verified,
        leftovers: reply.leftovers,
      };
    },
    async protect(password, allow) {
      return expect(
        await send({ kind: "protect", password, ...(allow ? { allow } : {}) }),
        "document",
      ).info;
    },
    async search(query, order, onProgress) {
      const reply = expect(await send({ kind: "search", query, order }, [], onProgress), "hits");
      return { hits: reply.hits, truncated: reply.truncated };
    },
    async save(order, annotations) {
      return expect(await send({ kind: "save", order, annotations }), "saved").bytes;
    },
    async fromImages(images) {
      return expect(
        await send(
          { kind: "fromImages", images },
          images.map((image) => image.bytes),
        ),
        "document",
      ).info;
    },
    async ocr(positions, order, annotations, languages, assets, despeckle, onProgress) {
      const reply = expect(
        await send(
          { kind: "ocr", positions, order, annotations, languages, assets, despeckle },
          [],
          onProgress,
        ),
        "ocrDone",
      );
      return { info: reply.info, recognised: reply.recognised, skipped: reply.skipped };
    },
    async toImages(positions, order, scale, onProgress) {
      return expect(
        await send({ kind: "toImages", positions, order, scale }, [], onProgress),
        "images",
      ).images;
    },
    async split(at, order, annotations) {
      return expect(await send({ kind: "split", at, order, annotations }), "parts").parts;
    },
    async close() {
      expect(await send({ kind: "close" }), "closed");
    },
    cancel(id) {
      worker.postMessage({ kind: "cancel", target: id, id: nextId++ } satisfies WorkerRequest);
    },
    terminate() {
      worker.terminate();
      pending.clear();
    },
  };
}
