import { useCallback, useEffect, useRef, useState } from "react";
import type { Annotation } from "@pdf-suite/core";
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
    }));
  }, [run]);

  /** Sets or clears the password the document is saved with. */
  const protect = useCallback(
    async (password: string | null) => {
      const info = await run("Updating protection", (worker) => worker.protect(password));
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

  const addAnnotation = useCallback((annotation: Annotation) => {
    setState((s) => ({ ...s, annotations: [...s.annotations, annotation] }));
  }, []);

  const removeAnnotation = useCallback((index: number) => {
    setState((s) => ({ ...s, annotations: s.annotations.filter((_, i) => i !== index) }));
  }, []);

  const clearAnnotations = useCallback(() => {
    setState((s) => ({ ...s, annotations: [] }));
  }, []);

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

  const setOrder = useCallback((order: number[]) => setState((s) => ({ ...s, order })), []);

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
    addAnnotation,
    removeAnnotation,
    clearAnnotations,
    pageText,
    setOrder,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
