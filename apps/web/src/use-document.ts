import { useCallback, useEffect, useRef, useState } from "react";
import type { Annotation, FieldValues } from "@pdf-suite/core";
import type {
  AccessibilityIssue,
  Attachment,
  DocumentDiff,
  EncryptOptions,
  Bookmark,
  Box,
  PageLabelRange,
  WatermarkOptions,
  DocumentProperties,
  EditableText,
  FindRequest,
  Found,
  ImageEdit,
  NewField,
  PageImage,
  SanitiseOptions,
  SanitiseReport,
  RedactArea,
  StampOptions,
  TextEdit,
} from "@pdf-suite/workers";
import {
  createPdfWorkerClient,
  type DocumentInfo,
  type PdfWorkerClient,
  type SearchHit,
} from "@pdf-suite/workers";
import pdfiumWasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import qpdfWasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";
import { insertPages } from "@pdf-suite/ui";
import { readFiles, type PickedFile } from "./file-io.js";

export interface DocumentState {
  // Explicitly `| undefined` because exactOptionalPropertyTypes is on and these
  // are cleared as well as set.
  name?: string | undefined;
  info?: DocumentInfo | undefined;
  /** Source page indices in display order; reordering only rewrites this. */
  order: number[];
  handle?: FileSystemFileHandle | undefined;
  /** Where it came from in the desktop shell, so Save can write back there. */
  path?: string | undefined;
  /** Name of the document waiting on a password; the worker holds its bytes. */
  needsPassword?: string | undefined;
  /**
   * Annotations the user has placed but not saved. They are written into the
   * bytes by any operation that rewrites the document, which is also why they
   * are cleared when that happens: at that point they are in the document.
   */
  annotations: Annotation[];
  busy: string | undefined;
  error: string | undefined;
}

const initial: DocumentState = {
  order: [],
  annotations: [],
  busy: undefined,
  error: undefined,
};

export function useDocument() {
  const client = useRef<PdfWorkerClient | null>(null);
  const [ready, setReady] = useState(false);
  /**
   * Bumped whenever the worker holds a different document. The render callback
   * depends on it so that every page re-rasterises: without it, opening another
   * document with the same page geometry left the previous document's pixels on
   * screen, because nothing the canvas depends on had changed.
   */
  const [docVersion, setDocVersion] = useState(0);
  const [state, setState] = useState<DocumentState>(initial);
  // Callbacks need the current order without being rebuilt on every reorder,
  // which would remount the viewer's render callback with it.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const worker = createPdfWorkerClient();
    client.current = worker;
    let alive = true;

    // Both wasm assets come from our own bundle, never a CDN (docs/PRIVACY.md).
    // qpdf is passed as a URL and fetched by the worker only when first needed.
    void fetch(pdfiumWasmUrl)
      .then((res) => res.arrayBuffer())
      .then((wasm) => worker.init(wasm, new URL(qpdfWasmUrl, location.href).href))
      .then(() => {
        if (alive) setReady(true);
      })
      .catch((err: unknown) => {
        if (alive)
          setState((s) => ({ ...s, error: `Could not start the PDF engine: ${message(err)}` }));
      });

    return () => {
      alive = false;
      worker.terminate();
    };
  }, []);

  const run = useCallback(
    async <T>(
      busy: string,
      work: (worker: PdfWorkerClient) => Promise<T>,
    ): Promise<T | undefined> => {
      const worker = client.current;
      if (!worker) return undefined;
      setState((s) => ({ ...s, busy, error: undefined }));
      try {
        return await work(worker);
      } catch (err) {
        setState((s) => ({ ...s, error: message(err) }));
        return undefined;
      } finally {
        setState((s) => ({ ...s, busy: undefined }));
      }
    },
    [],
  );

  /**
   * Opens a file. A document that needs a password is reported as
   * `needsPassword` rather than as an error, so the app can ask for one; the
   * bytes stay in the worker, since open() transferred them.
   */
  const open = useCallback(async (file: PickedFile) => {
    const worker = client.current;
    if (!worker) return;
    setState((s) => ({ ...s, busy: "Opening", error: undefined }));
    try {
      const info = await worker.open(file.bytes);
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        name: file.name,
        info,
        order: info.pageSizes.map((_, i) => i),
        handle: file.handle,
        needsPassword: undefined,
        error: undefined,
      }));
    } catch (err) {
      if (err instanceof Error && err.name === "PasswordRequiredError") {
        setState((s) => ({ ...s, name: file.name, needsPassword: file.name, error: undefined }));
        return;
      }
      setState((s) => ({ ...s, error: message(err) }));
    } finally {
      setState((s) => ({ ...s, busy: undefined }));
    }
  }, []);

  /** Supplies the password for the document the worker is holding. */
  const unlock = useCallback(async (password: string) => {
    const worker = client.current;
    if (!worker) return;
    setState((s) => ({ ...s, busy: "Unlocking", error: undefined }));
    try {
      const info = await worker.unlock(password);
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info,
        order: info.pageSizes.map((_, i) => i),
        needsPassword: undefined,
        error: undefined,
        // A decrypted copy is a new document; it must not overwrite the original.
        handle: undefined,
        path: undefined,
      }));
    } catch (err) {
      const wrong = err instanceof Error && err.name === "WrongPasswordError";
      setState((s) => ({
        ...s,
        error: wrong ? "That password did not work" : message(err),
      }));
    } finally {
      setState((s) => ({ ...s, busy: undefined }));
    }
  }, []);

  /**
   * Appends `files` and places the new pages at display position `at` (end when
   * omitted). The worker applies the current order first, so pages deleted
   * before a merge stay deleted.
   */
  const mergeIn = useCallback(
    async (files: PickedFile[], at?: number) => {
      if (files.length === 0) return;
      const before = stateRef.current.order.length;
      const info = await run("Merging", (worker) =>
        worker.merge(
          files.map((f) => f.bytes),
          stateRef.current.order,
          stateRef.current.annotations,
        ),
      );
      if (!info) return;
      setDocVersion((v) => v + 1);
      // The merged document renumbers every page, so the display order restarts
      // with the appended pages moved to where they were asked for.
      const appended = Array.from({ length: info.pageCount - before }, (_, i) => before + i);
      const kept = Array.from({ length: before }, (_, i) => i);
      setState((s) => ({
        ...s,
        info,
        order: insertPages(kept, appended, at),
        // Pending annotations were written in by the merge.
        annotations: [],
        // A merged document is a different document: never write back in place.
        handle: undefined,
        path: undefined,
      }));
    },
    [run],
  );

  /** Rotates the given display positions, rewriting the document. */
  const rotatePages = useCallback(
    async (positions: number[], by: 90 | 180 | 270) => {
      if (positions.length === 0) return;
      const info = await run("Rotating", (worker) =>
        worker.rotate(positions, by, stateRef.current.order, stateRef.current.annotations),
      );
      if (!info) return;
      setDocVersion((v) => v + 1);
      // Rotating materialises the order, so the document is now exactly what was
      // on screen and the order restarts as the identity.
      setState((s) => ({
        ...s,
        info,
        order: info.pageSizes.map((_, i) => i),
        annotations: [],
        handle: undefined,
        path: undefined,
      }));
    },
    [run],
  );

  const render = useCallback(
    (page: number, scale: number) => {
      const worker = client.current;
      if (!worker) return Promise.reject(new Error("worker not ready"));
      return worker.render(page, scale);
    },
    // docVersion is the whole point of this dependency: a different document
    // means different pixels for the same page number, and the page canvases
    // re-rasterise only when this callback's identity changes.
    [docVersion],
  );

  const save = useCallback(
    async (order: number[]) =>
      run("Saving", (worker) => worker.save(order, stateRef.current.annotations)),
    [run],
  );

  /** Recompresses the document, reporting the size change. */
  const compress = useCallback(async () => {
    const info = await run("Compressing", (worker) =>
      worker.compress(stateRef.current.order, stateRef.current.annotations),
    );
    if (!info) return;
    setDocVersion((v) => v + 1);
    setState((s) => ({
      ...s,
      info,
      order: info.pageSizes.map((_, i) => i),
      annotations: [],
      handle: undefined,
      path: undefined,
    }));
  }, [run]);

  /** Sets or clears the password the document is saved with. */
  const protect = useCallback(
    async (password: string | null, allow?: EncryptOptions["allow"]) => {
      const info = await run("Updating protection", (worker) => worker.protect(password, allow));
      if (!info) return;
      setState((s) => ({ ...s, info, handle: undefined }));
    },
    [run],
  );

  /**
   * Searches the document as displayed. Returns undefined if the search was
   * cancelled or failed; `truncated` means the hit limit was reached.
   */
  const search = useCallback(
    async (query: string): Promise<{ hits: SearchHit[]; truncated: boolean } | undefined> => {
      if (query.trim() === "") return { hits: [], truncated: false };
      return run("Searching", (worker) =>
        worker.search(query, stateRef.current.order, (done, total) =>
          setState((s) => ({ ...s, busy: `Searching page ${done} of ${total}` })),
        ),
      );
    },
    [run],
  );

  /**
   * Undo for the changes the worker's history cannot see: page order and marks
   * both live here until an operation writes them into the bytes. Once that
   * happens the worker's history covers them, which is why these are dropped
   * whenever the document changes, below — putting a mark back into bytes that
   * already contain it would duplicate it.
   */
  interface UiStep {
    order: number[];
    annotations: Annotation[];
  }
  const [uiPast, setUiPast] = useState<UiStep[]>([]);
  const [uiFuture, setUiFuture] = useState<UiStep[]>([]);

  // Anything that rewrites the document writes the pending marks into it, so
  // from that point their history is the worker's, not this one's.
  useEffect(() => {
    setUiPast([]);
    setUiFuture([]);
  }, [state.info]);

  /** Call before changing page order or marks, never after. */
  const remember = useCallback(() => {
    const { order, annotations } = stateRef.current;
    setUiPast((p) => [...p, { order, annotations }]);
    setUiFuture([]);
  }, []);

  const addAnnotation = useCallback(
    (annotation: Annotation) => {
      remember();
      setState((s) => ({ ...s, annotations: [...s.annotations, annotation] }));
    },
    [remember],
  );

  const removeAnnotation = useCallback(
    (index: number) => {
      remember();
      setState((s) => ({ ...s, annotations: s.annotations.filter((_, i) => i !== index) }));
    },
    [remember],
  );

  const clearAnnotations = useCallback(() => {
    remember();
    setState((s) => ({ ...s, annotations: [] }));
  }, [remember]);

  /**
   * Steps the document back, or forward again.
   *
   * Reordering pages and placing marks come first: they are always the most
   * recent changes, because anything that rewrites the document writes them into
   * it and clears them. Once there are none left to put back, the step is the
   * worker's, and it returns the page order and the marks that version had.
   */
  const step = useCallback(
    async (direction: "undo" | "redo") => {
      const mine = direction === "undo" ? uiPast : uiFuture;
      const last = mine[mine.length - 1];
      if (last) {
        const { order, annotations } = stateRef.current;
        if (direction === "undo") {
          setUiPast((p) => p.slice(0, -1));
          setUiFuture((f) => [...f, { order, annotations }]);
        } else {
          setUiFuture((f) => f.slice(0, -1));
          setUiPast((p) => [...p, { order, annotations }]);
        }
        setState((s) => ({ ...s, order: last.order, annotations: last.annotations }));
        return;
      }

      const result = await run(direction === "undo" ? "Undoing" : "Redoing", (worker) =>
        worker[direction](stateRef.current.order, stateRef.current.annotations),
      );
      if (!result) return;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info: result.info,
        order: result.order,
        annotations: result.annotations,
        // The file on disk is no longer what is on screen, as after any change.
        handle: undefined,
        path: undefined,
      }));
    },
    [run, uiFuture, uiPast],
  );

  /**
   * Removes the content inside the given areas. Returns the verification result,
   * which the caller must show: an unverified redaction is not a redaction.
   */
  const redact = useCallback(
    async (areas: RedactArea[]) => {
      const result = await run("Redacting", (worker) =>
        worker.redact(areas, stateRef.current.order, stateRef.current.annotations),
      );
      if (!result) return undefined;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info: result.info,
        order: result.info.pageSizes.map((_, i) => i),
        annotations: [],
        // Redaction rewrites the document; it must not overwrite the original.
        handle: undefined,
        path: undefined,
      }));
      return result;
    },
    [run],
  );

  /** The text runs on a page that can be edited in place. */
  const editableText = useCallback(async (page: number): Promise<EditableText[]> => {
    const worker = client.current;
    if (!worker) return [];
    try {
      return await worker.editableText(page, stateRef.current.order, stateRef.current.annotations);
    } catch {
      // A page whose text cannot be read is not an error worth a banner; it
      // simply has nothing to edit.
      return [];
    }
  }, []);

  /** Replaces the text of the named runs, rewriting the document. */
  const editText = useCallback(
    async (edits: TextEdit[]) => {
      const result = await run("Editing text", (worker) =>
        worker.editText(edits, stateRef.current.order, stateRef.current.annotations),
      );
      if (!result) return undefined;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info: result.info,
        order: result.info.pageSizes.map((_, i) => i),
        annotations: [],
        // The page content changed, so this is a different document.
        handle: undefined,
        path: undefined,
      }));
      return result;
    },
    [run],
  );

  /** Writes form values, optionally flattening them so they cannot be edited. */
  const applyForm = useCallback(
    async (values: FieldValues, flatten: boolean) => {
      const info = await run(flatten ? "Flattening form" : "Saving form values", (worker) =>
        worker.fillForm(values, flatten, stateRef.current.order, stateRef.current.annotations),
      );
      if (!info) return false;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info,
        order: info.pageSizes.map((_, i) => i),
        annotations: [],
        handle: undefined,
        path: undefined,
      }));
      return true;
    },
    [run],
  );

  /** Builds a document from dropped or picked images and opens it. */
  const openImages = useCallback(
    async (files: PickedFile[]) => {
      if (files.length === 0) return;
      const info = await run("Converting images", (worker) =>
        worker.fromImages(files.map((f) => ({ bytes: f.bytes, type: f.type ?? f.name }))),
      );
      if (!info) return;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        name: files.length === 1 ? `${stripExtension(files[0]!.name)}.pdf` : "images.pdf",
        info,
        order: info.pageSizes.map((_, i) => i),
        annotations: [],
        // Converted images are a new document with nowhere to write back to.
        handle: undefined,
        path: undefined,
      }));
    },
    [run],
  );

  /**
   * Makes pages searchable with OCR. Assets come from our own origin, served by
   * the ocrAssets() Vite plugin — tesseract.js would otherwise use a CDN.
   */
  const runOcr = useCallback(
    async (positions: number[], languages: string[], despeckle: boolean) => {
      const result = await run("Reading text", (worker) =>
        worker.ocr(
          positions,
          stateRef.current.order,
          stateRef.current.annotations,
          languages,
          // Absolute URLs, not root-relative: tesseract.js wraps its worker in
          // a blob, and inside a blob worker importScripts has no base path to
          // resolve "/ocr/..." against.
          {
            workerPath: new URL("/ocr/worker.min.js", location.href).href,
            corePath: new URL("/ocr/core/", location.href).href,
            langPath: new URL("/ocr/lang/", location.href).href,
          },
          despeckle,
          (done, total) =>
            setState((s) => ({ ...s, busy: `Reading text, page ${done} of ${total}` })),
        ),
      );
      if (!result) return undefined;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info: result.info,
        order: result.info.pageSizes.map((_, i) => i),
        annotations: [],
        // Recognised pages are re-encoded images, so this is a new document.
        handle: undefined,
        path: undefined,
      }));
      return result;
    },
    [run],
  );

  /** Renders the given display positions to PNG. */
  const exportImages = useCallback(
    async (positions: number[], scale = 2) =>
      run("Rendering images", (worker) =>
        worker.toImages(positions, stateRef.current.order, scale, (done, total) =>
          setState((s) => ({ ...s, busy: `Rendering page ${done} of ${total}` })),
        ),
      ),
    [run],
  );

  /**
   * Splits at the selected display positions and returns one document per part.
   * The open document is left alone, like extract.
   */
  const splitAt = useCallback(
    async (at: number[]) =>
      run("Splitting", (worker) =>
        worker.split(at, stateRef.current.order, stateRef.current.annotations),
      ),
    [run],
  );

  /** Text runs for one source page, for snapping a highlight to whole lines. */
  const pageText = useCallback(async (page: number) => {
    const worker = client.current;
    if (!worker) return [];
    try {
      return await worker.pageText(page);
    } catch {
      // A page with no text layer (a scan) is not an error; it just cannot snap.
      return [];
    }
  }, []);

  const setOrder = useCallback(
    (order: number[]) => {
      remember();
      setState((s) => ({ ...s, order }));
    },
    [remember],
  );

  /**
   * Draws headers, footers and page numbers into the document. Display
   * positions, not source pages: "page 1" is the page the reader sees first.
   */
  const stamp = useCallback(
    async (options: StampOptions) => {
      const info = await run("Numbering pages", (worker) =>
        worker.stamp(options, stateRef.current.order, stateRef.current.annotations),
      );
      if (!info) return false;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info,
        order: info.pageSizes.map((_, i) => i),
        annotations: [],
        handle: undefined,
        path: undefined,
      }));
      return true;
    },
    [run],
  );

  /** Writes the document's title, author, subject and keywords. */
  const describe = useCallback(
    async (properties: Partial<DocumentProperties>) => {
      const info = await run("Saving the description", (worker) =>
        worker.setProperties(properties, stateRef.current.order, stateRef.current.annotations),
      );
      if (!info) return false;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info,
        order: info.pageSizes.map((_, i) => i),
        annotations: [],
        handle: undefined,
        path: undefined,
      }));
      return true;
    },
    [run],
  );

  /** The images on a page, with where each one sits. */
  const pageImages = useCallback(async (page: number): Promise<PageImage[]> => {
    const worker = client.current;
    if (!worker) return [];
    try {
      return await worker.images(page, stateRef.current.order, stateRef.current.annotations);
    } catch {
      // A page whose images cannot be read simply has none to edit.
      return [];
    }
  }, []);

  /** Moves, resizes or removes images, rewriting the document. */
  const editImages = useCallback(
    async (edits: ImageEdit[]) => {
      const result = await run("Editing the picture", (worker) =>
        worker.editImages(edits, stateRef.current.order, stateRef.current.annotations),
      );
      if (!result) return undefined;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info: result.info,
        order: result.info.pageSizes.map((_, i) => i),
        annotations: [],
        handle: undefined,
        path: undefined,
      }));
      return result;
    },
    [run],
  );

  /** Replaces the document's bookmarks with the tree given. */
  const setBookmarks = useCallback(
    async (bookmarks: Bookmark[]) => {
      const info = await run("Saving bookmarks", (worker) =>
        worker.setOutline(bookmarks, stateRef.current.order, stateRef.current.annotations),
      );
      if (!info) return false;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info,
        order: info.pageSizes.map((_, i) => i),
        annotations: [],
        handle: undefined,
        path: undefined,
      }));
      return true;
    },
    [run],
  );

  /** One rewrite, one new document: the shape every page-level op shares. */
  const rewrite = useCallback(
    async (busy: string, work: (worker: PdfWorkerClient) => Promise<DocumentInfo>) => {
      const info = await run(busy, work);
      if (!info) return false;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info,
        order: info.pageSizes.map((_, i) => i),
        annotations: [],
        handle: undefined,
        path: undefined,
      }));
      return true;
    },
    [run],
  );

  /** Removes a mark the document already carried. */
  const deleteMark = useCallback(
    async (page: number, index: number) =>
      rewrite("Removing the mark", (worker) =>
        worker.deleteMark(page, index, stateRef.current.order, stateRef.current.annotations),
      ),
    [rewrite],
  );

  /** Compares another document with this one. Changes nothing. */
  const compare = useCallback(
    async (other: ArrayBuffer): Promise<DocumentDiff | undefined> =>
      run("Comparing", (worker) =>
        worker.compare(other, stateRef.current.order, stateRef.current.annotations),
      ),
    [run],
  );

  /** The files carried inside the document. */
  const attachments = useCallback(async (): Promise<Attachment[]> => {
    const worker = client.current;
    if (!worker) return [];
    try {
      return await worker.attachments(stateRef.current.order, stateRef.current.annotations);
    } catch {
      return [];
    }
  }, []);

  const attach = useCallback(
    async (file: { name: string; bytes: ArrayBuffer; type?: string | undefined }) =>
      rewrite("Attaching the file", (worker) =>
        worker.attach(file, stateRef.current.order, stateRef.current.annotations),
      ),
    [rewrite],
  );

  const readAttachment = useCallback(
    async (name: string) =>
      run("Reading the attachment", (worker) =>
        worker.readAttachment(name, stateRef.current.order, stateRef.current.annotations),
      ),
    [run],
  );

  const removeAttachment = useCallback(
    async (name: string) =>
      rewrite("Removing the attachment", (worker) =>
        worker.removeAttachment(name, stateRef.current.order, stateRef.current.annotations),
      ),
    [rewrite],
  );

  /** Adds a form field where the user drew it. */
  const addFormField = useCallback(
    async (field: NewField) =>
      rewrite("Adding the field", (worker) =>
        worker.addField(field, stateRef.current.order, stateRef.current.annotations),
      ),
    [rewrite],
  );

  const removeFormField = useCallback(
    async (name: string) =>
      rewrite("Removing the field", (worker) =>
        worker.removeField(name, stateRef.current.order, stateRef.current.annotations),
      ),
    [rewrite],
  );

  /** The document's text, in the order on screen. */
  const extractAllText = useCallback(
    async () => run("Extracting text", (worker) => worker.toText(stateRef.current.order)),
    [run],
  );

  /** Crops pages, or puts the whole page back when the box is null. */
  const crop = useCallback(
    async (box: Box | null, pages?: number[]) =>
      rewrite("Cropping", (worker) =>
        worker.crop(box, pages, stateRef.current.order, stateRef.current.annotations),
      ),
    [rewrite],
  );

  const addWatermark = useCallback(
    async (options: WatermarkOptions) =>
      rewrite("Adding the watermark", (worker) =>
        worker.watermark(options, stateRef.current.order, stateRef.current.annotations),
      ),
    [rewrite],
  );

  const setLabels = useCallback(
    async (ranges: PageLabelRange[]) =>
      rewrite("Numbering the pages", (worker) =>
        worker.pageLabels(ranges, stateRef.current.order, stateRef.current.annotations),
      ),
    [rewrite],
  );

  /** Whether a screen reader could read this document. Changes nothing. */
  const checkAccessible = useCallback(
    async (): Promise<AccessibilityIssue[] | undefined> =>
      run("Checking accessibility", (worker) =>
        worker.checkAccessible(stateRef.current.order, stateRef.current.annotations),
      ),
    [run],
  );

  /** Sets the title, the language and the window-title flag. */
  const fixAccessible = useCallback(
    async (title: string, language: string) => {
      const info = await run("Setting the title and language", (worker) =>
        worker.fixAccessible(title, language, stateRef.current.order, stateRef.current.annotations),
      );
      if (!info) return false;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info,
        order: info.pageSizes.map((_, i) => i),
        annotations: [],
        handle: undefined,
        path: undefined,
      }));
      return true;
    },
    [run],
  );

  /** What the document carries but does not show. Changes nothing. */
  const findHidden = useCallback(
    async (): Promise<SanitiseReport | undefined> =>
      run("Checking what is hidden", (worker) =>
        worker.findHidden(stateRef.current.order, stateRef.current.annotations),
      ),
    [run],
  );

  /** Removes it. */
  const sanitise = useCallback(
    async (options: SanitiseOptions) => {
      const result = await run("Removing hidden information", (worker) =>
        worker.sanitise(options, stateRef.current.order, stateRef.current.annotations),
      );
      if (!result) return undefined;
      setDocVersion((v) => v + 1);
      setState((s) => ({
        ...s,
        info: result.info,
        order: result.info.pageSizes.map((_, i) => i),
        annotations: [],
        handle: undefined,
        path: undefined,
      }));
      return result;
    },
    [run],
  );

  /** Finds personal numbers or words, without changing the document. */
  const findPattern = useCallback(
    async (request: FindRequest): Promise<Found | undefined> =>
      run("Searching", (worker) =>
        worker.findPattern(request, stateRef.current.order, stateRef.current.annotations),
      ),
    [run],
  );

  /** Saves just the given source pages, leaving the open document alone. */
  const extract = useCallback(
    async (pages: number[]) =>
      run("Extracting", (worker) => worker.save(pages, stateRef.current.annotations)),
    [run],
  );

  const openFiles = useCallback(
    async (files: FileList | File[]) => {
      const picked = await readFiles(files);
      if (picked[0]) await open(picked[0]);
    },
    [open],
  );

  return {
    ready,
    state,
    open,
    unlock,
    openFiles,
    mergeIn,
    rotatePages,
    compress,
    protect,
    render,
    save,
    extract,
    search,
    splitAt,
    openImages,
    exportImages,
    runOcr,
    applyForm,
    redact,
    editableText,
    editText,
    pageImages,
    editImages,
    stamp,
    describe,
    findPattern,
    setBookmarks,
    deleteMark,
    compare,
    attachments,
    attach,
    readAttachment,
    removeAttachment,
    addFormField,
    removeFormField,
    extractAllText,
    crop,
    addWatermark,
    setLabels,
    checkAccessible,
    fixAccessible,
    findHidden,
    sanitise,
    addAnnotation,
    removeAnnotation,
    clearAnnotations,
    undo: () => step("undo"),
    redo: () => step("redo"),
    canUndo: uiPast.length > 0 || (state.info?.undo ?? 0) > 0,
    canRedo: uiFuture.length > 0 || (state.info?.redo ?? 0) > 0,
    pageText,
    setOrder,
  };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
