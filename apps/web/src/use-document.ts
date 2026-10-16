import { useCallback, useEffect, useRef, useState } from "react";
import { createPdfWorkerClient, type DocumentInfo, type PdfWorkerClient } from "@pdf-suite/workers";
import pdfiumWasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
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

  const mergeIn = useCallback(
    async (files: PickedFile[]) => {
      if (files.length === 0) return;
      const info = await run("Merging", (worker) => worker.merge(files.map((f) => f.bytes)));
      if (!info) return;
      // Page identities changed, so the display order restarts, and the result is
      // a new document: it must not silently overwrite the file we opened.
      setState((s) => ({ ...s, info, order: info.pageSizes.map((_, i) => i), handle: undefined }));
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

  const openFiles = useCallback(
    async (files: FileList | File[]) => {
      const picked = await readFiles(files);
      if (picked[0]) await open(picked[0]);
    },
    [open],
  );

  return { ready, state, open, openFiles, mergeIn, render, save, setOrder };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
