import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pagesAt, removePages, Thumbnails, Viewer } from "@pdf-suite/ui";
import { canUsePicker, pickFiles, readFiles, saveBytes, suffixName } from "./file-io.js";
import { useDocument } from "./use-document.js";

export function App() {
  const { ready, state, open, mergeIn, rotatePages, render, save, extract, setOrder } =
    useDocument();
  const openInput = useRef<HTMLInputElement>(null);
  const mergeInput = useRef<HTMLInputElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [saved, setSaved] = useState<string | undefined>();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

  const info = state.info;
  const pageCount = state.order.length;

  // Pages are laid out to the available width, so track it.
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Positions move when pages are added, removed or reordered, so a stale
  // selection would point at the wrong pages.
  useEffect(() => setSelected(new Set()), [info]);

  const onSelect = useCallback((position: number, extend: boolean) => {
    setSelected((current) => {
      const next = new Set(extend ? current : []);
      if (next.has(position)) next.delete(position);
      else next.add(position);
      return next;
    });
  }, []);

  const name = state.name ?? "document.pdf";
  /** Positions in ascending display order, which is what every op expects. */
  const positions = useMemo(() => [...selected].sort((a, b) => a - b), [selected]);
  const target = positions.length > 0 ? positions : state.order.map((_, i) => i);

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
    // One selected page means "insert after this one"; otherwise append.
    const at = positions.length === 1 ? positions[0]! + 1 : undefined;
    await mergeIn(await pickFiles(true), at);
  }, [mergeIn, positions]);

  const onMergeInput = useCallback(
    async (files: FileList | null) => {
      const at = positions.length === 1 ? positions[0]! + 1 : undefined;
      return mergeIn(await readFiles(files ?? []), at);
    },
    [mergeIn, positions],
  );

  const onOpenInput = useCallback(
    async (files: FileList | null) => {
      const picked = await readFiles(files ?? []);
      if (picked[0]) await open(picked[0]);
    },
    [open],
  );

  const handleSave = useCallback(async () => {
    const bytes = await save(state.order);
    if (!bytes) return;
    // Anything but the untouched document is a different document, so it must
    // not silently overwrite the file that was opened.
    const edited = !state.handle || state.order.length !== info?.pageCount;
    const written = await saveBytes(
      bytes,
      edited ? suffixName(name, "edited") : name,
      edited ? undefined : state.handle,
    );
    setSaved(written ? `Saved ${written}` : undefined);
  }, [info?.pageCount, name, save, state.handle, state.order]);

  const handleExtract = useCallback(async () => {
    const pages = pagesAt(state.order, positions);
    const bytes = await extract(pages);
    if (!bytes) return;
    const written = await saveBytes(bytes, suffixName(name, `${pages.length} pages`));
    setSaved(written ? `Saved ${written}` : undefined);
  }, [extract, name, positions, state.order]);

  const handleDelete = useCallback(() => {
    if (positions.length === 0 || positions.length === pageCount) return;
    setOrder(removePages(state.order, positions));
    setSelected(new Set());
  }, [pageCount, positions, setOrder, state.order]);

  const status = state.error ?? state.busy ?? saved;
  const disabled = !ready || !info || state.busy !== undefined;

  return (
    <div className="app">
      <header className="toolbar">
        <strong>PDF Suite</strong>
        <button type="button" onClick={handleOpen} disabled={!ready}>
          Open
        </button>
        <button type="button" onClick={handleMerge} disabled={disabled}>
          {positions.length === 1 ? "Insert after…" : "Merge…"}
        </button>
        <button type="button" onClick={handleSave} disabled={disabled}>
          Save
        </button>

        <span className="toolbar-group" role="group" aria-label="Organize">
          <button
            type="button"
            onClick={() => void rotatePages(target, 270)}
            disabled={disabled}
            aria-label="Rotate left"
            title="Rotate left"
          >
            ↺
          </button>
          <button
            type="button"
            onClick={() => void rotatePages(target, 90)}
            disabled={disabled}
            aria-label="Rotate right"
            title="Rotate right"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={disabled || positions.length === 0 || positions.length === pageCount}
          >
            Delete
          </button>
          <button
            type="button"
            onClick={handleExtract}
            disabled={disabled || positions.length === 0}
          >
            Extract…
          </button>
        </span>

        <span className="toolbar-name">{state.name ?? "No document open"}</span>
        {info ? (
          <span className="toolbar-pages">
            {pageCount} {pageCount === 1 ? "page" : "pages"}
            {positions.length > 0 ? `, ${positions.length} selected` : ""}
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
            selected={selected}
            onSelect={onSelect}
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
          <p className="empty-hint">
            Click a page thumbnail to select it; shift-click to select more. Rotate, delete and
            extract act on the selection, or on the whole document when nothing is selected.
          </p>
        </main>
      )}
    </div>
  );
}
