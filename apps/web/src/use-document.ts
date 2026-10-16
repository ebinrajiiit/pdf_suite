import { useCallback, useEffect, useRef, useState } from "react";
import { createPdfWorkerClient, type DocumentInfo, type PdfWorkerClient } from "@pdf-suite/workers";
import pdfiumWasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
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
  busy: string | undefined;
  error: string | undefined;
}

const initial: DocumentState = { order: [], busy: undefined, error: undefined };

export function useDocument() {
  const client = useRef<PdfWorkerClient | null>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<DocumentState>(initial);
  // Callbacks need the current order without being rebuilt on every reorder,
  // which would remount the viewer's render callback with it.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const worker = createPdfWorkerClient();
    client.current = worker;
    let alive = true;

    // The wasm comes from our own bundle, never a CDN (docs/PRIVACY.md).
    void fetch(pdfiumWasmUrl)
      .then((res) => res.arrayBuffer())
      .then((wasm) => worker.init(wasm))
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

  const open = useCallback(
    async (file: PickedFile) => {
      const info = await run("Opening", (worker) => worker.open(file.bytes));
      if (!info) return;
      setState((s) => ({
        ...s,
        name: file.name,
        info,
        order: info.pageSizes.map((_, i) => i),
        handle: file.handle,
      }));
    },
    [run],
  );

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
        ),
      );
      if (!info) return;
      // The merged document renumbers every page, so the display order restarts
      // with the appended pages moved to where they were asked for.
      const appended = Array.from({ length: info.pageCount - before }, (_, i) => before + i);
      const kept = Array.from({ length: before }, (_, i) => i);
      setState((s) => ({
        ...s,
        info,
        order: insertPages(kept, appended, at),
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
        worker.rotate(positions, by, stateRef.current.order),
      );
      if (!info) return;
      // Rotating materialises the order, so the document is now exactly what was
      // on screen and the order restarts as the identity.
      setState((s) => ({
        ...s,
        info,
        order: info.pageSizes.map((_, i) => i),
        handle: undefined,
      }));
    },
    [run],
  );

  const render = useCallback((page: number, scale: number) => {
    const worker = client.current;
    if (!worker) return Promise.reject(new Error("worker not ready"));
    return worker.render(page, scale);
  }, []);

  const save = useCallback(
    async (order: number[]) => run("Saving", (worker) => worker.save(order)),
    [run],
  );

  const setOrder = useCallback((order: number[]) => setState((s) => ({ ...s, order })), []);

  /** Saves just the given source pages, leaving the open document alone. */
  const extract = useCallback(
    async (pages: number[]) => run("Extracting", (worker) => worker.save(pages)),
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
    openFiles,
    mergeIn,
    rotatePages,
    render,
    save,
    extract,
    setOrder,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
