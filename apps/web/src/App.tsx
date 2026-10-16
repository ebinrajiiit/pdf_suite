import { useCallback, useEffect, useRef, useState } from "react";
import { Thumbnails, Viewer } from "@pdf-suite/ui";
import { canUsePicker, pickFiles, readFiles, saveBytes, suffixName } from "./file-io.js";
import { useDocument } from "./use-document.js";

export function App() {
  const { ready, state, open, mergeIn, render, save, setOrder } = useDocument();
  const openInput = useRef<HTMLInputElement>(null);
  const mergeInput = useRef<HTMLInputElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [saved, setSaved] = useState<string | undefined>();

  // Pages are laid out to the available width, so track it.
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const handleOpen = useCallback(async () => {
    if (!canUsePicker()) {
      openInput.current?.click();
      return;
    }
    const picked = await pickFiles(false);
    if (picked[0]) await open(picked[0]);
  }, [open]);

  const handleMerge = useCallback(async () => {
    if (!canUsePicker()) {
      mergeInput.current?.click();
      return;
    }
    await mergeIn(await pickFiles(true));
  }, [mergeIn]);

  const handleSave = useCallback(async () => {
    const bytes = await save(state.order);
    if (!bytes) return;
    const name = suffixName(state.name ?? "document.pdf", "edited");
    // Reordered pages make a different document, so never write back in place.
    const identity = state.order.every((page, i) => page === i);
    const written = await saveBytes(
      bytes,
      identity ? (state.name ?? "document.pdf") : name,
      identity ? state.handle : undefined,
    );
    setSaved(written ? `Saved ${written}` : undefined);
  }, [save, state.handle, state.name, state.order]);

  const onOpenInput = useCallback(
    async (files: FileList | null) => {
      const picked = await readFiles(files ?? []);
      if (picked[0]) await open(picked[0]);
    },
    [open],
  );

  const onMergeInput = useCallback(
    async (files: FileList | null) => mergeIn(await readFiles(files ?? [])),
    [mergeIn],
  );

  const info = state.info;
  const status = state.error ?? state.busy ?? saved;

  return (
    <div className="app">
      <header className="toolbar">
        <strong>PDF Suite</strong>
        <button type="button" onClick={handleOpen} disabled={!ready}>
          Open
        </button>
        <button type="button" onClick={handleMerge} disabled={!ready || !info}>
          Merge…
        </button>
        <button type="button" onClick={handleSave} disabled={!ready || !info}>
          Save
        </button>
        <span className="toolbar-name">{state.name ?? "No document open"}</span>
        {info ? (
          <span className="toolbar-pages">
            {state.order.length} {state.order.length === 1 ? "page" : "pages"}
          </span>
        ) : null}
        <span
          className={state.error ? "status status-error" : "status"}
          role="status"
          data-testid="status"
        >
          {status ?? (ready ? "Ready" : "Starting engine…")}
        </span>
      </header>

      {/* The pickers are unavailable in Firefox and Safari, and in tests; these
          inputs are the fallback path and stay out of the tab order otherwise. */}
      <input
        ref={openInput}
        type="file"
        accept="application/pdf,.pdf"
        data-testid="open-input"
        className="visually-hidden"
        onChange={(event) => void onOpenInput(event.target.files)}
      />
      <input
        ref={mergeInput}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        data-testid="merge-input"
        className="visually-hidden"
        onChange={(event) => void onMergeInput(event.target.files)}
      />

      {info ? (
        <div className="workspace">
          <Thumbnails
            order={state.order}
            pageSizes={info.pageSizes}
            render={render}
            onReorder={setOrder}
          />
          <div className="main" ref={main}>
            <Viewer
              order={state.order}
              pageSizes={info.pageSizes}
              render={render}
              containerWidth={width}
              pixelRatio={globalThis.devicePixelRatio || 1}
            />
          </div>
        </div>
      ) : (
        <main className="empty">
          <h1>Your files never leave this device</h1>
          <p>
            Open a PDF to view, reorder and merge it. Every operation runs here, on your computer —
            switch off your network and it keeps working.
          </p>
        </main>
      )}
    </div>
  );
}
