import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pagesAt, removePages, Thumbnails, Viewer, type Highlight } from "@pdf-suite/ui";
import type { SearchHit } from "@pdf-suite/workers";
import { canUsePicker, pickFiles, readFiles, saveBytes, suffixName } from "./file-io.js";
import { useDocument } from "./use-document.js";

export function App() {
  const {
    ready,
    state,
    open,
    unlock,
    mergeIn,
    rotatePages,
    compress,
    protect,
    render,
    save,
    extract,
    search,
    setOrder,
  } = useDocument();
  const openInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const mergeInput = useRef<HTMLInputElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [saved, setSaved] = useState<string | undefined>();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [askProtect, setAskProtect] = useState(false);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [dropping, setDropping] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const [truncated, setTruncated] = useState(false);

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

  const stepZoom = useCallback((by: number) => {
    setZoom((current) => {
      // "fit" is roughly a page width, so stepping away from it starts at 100%.
      const from = current === "fit" ? ZOOM_LEVELS.indexOf(1) : ZOOM_LEVELS.indexOf(current);
      const index = from === -1 ? ZOOM_LEVELS.indexOf(1) : from;
      return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index + by))] ?? 1;
    });
  }, []);

  // Ctrl/Cmd+F goes to our search, not the browser's, which cannot see inside a
  // canvas anyway. Zoom keys match what every viewer uses.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
        return;
      }
      if (!meta) return;
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        stepZoom(1);
      } else if (event.key === "-") {
        event.preventDefault();
        stepZoom(-1);
      } else if (event.key === "0") {
        event.preventDefault();
        setZoom("fit");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepZoom]);

  // Positions move when pages are added, removed or reordered, so a stale
  // selection or a stale set of hits would point at the wrong pages.
  useEffect(() => {
    setSelected(new Set());
    setHits([]);
    setHitIndex(0);
    setTruncated(false);
  }, [info]);
  useEffect(() => {
    setHits([]);
    setHitIndex(0);
  }, [state.order]);

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

  /**
   * Dropping a file opens it, or merges it when a document is already open —
   * the same two actions the toolbar offers, so nothing is silently discarded.
   */
  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      setDropping(false);
      const dropped = Array.from(event.dataTransfer.files).filter(
        (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
      );
      if (dropped.length === 0) return;
      const picked = await readFiles(dropped);
      if (!info) {
        if (picked[0]) await open(picked[0]);
        return;
      }
      await mergeIn(picked);
    },
    [info, mergeIn, open],
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

  const handleProtect = useCallback(async () => {
    if (info?.protected) {
      await protect(null);
      setSaved(undefined);
      return;
    }
    setAskProtect(true);
  }, [info?.protected, protect]);

  /** Hit boxes grouped by display position, which is what the Viewer draws. */
  const highlights = useMemo(() => {
    const byPosition = new Map<number, Highlight[]>();
    for (const hit of hits) {
      const list = byPosition.get(hit.position) ?? [];
      list.push(...hit.rects);
      byPosition.set(hit.position, list);
    }
    return byPosition;
  }, [hits]);

  /** Identifies the current hit as the Viewer keys them: "position:index". */
  const activeHighlight = useMemo(() => {
    const hit = hits[hitIndex];
    if (!hit) return undefined;
    const before = hits.slice(0, hitIndex).filter((h) => h.position === hit.position).length;
    return `${hit.position}:${before}`;
  }, [hits, hitIndex]);

  const handleSearch = useCallback(async () => {
    const found = await search(query);
    if (!found) return;
    setHits(found.hits);
    setTruncated(found.truncated);
    setHitIndex(0);
  }, [query, search]);

  const step = useCallback(
    (by: number) => {
      if (hits.length === 0) return;
      setHitIndex((current) => (current + by + hits.length) % hits.length);
    },
    [hits.length],
  );

  const status = state.error ?? state.busy ?? saved;
  const disabled = !ready || !info || state.busy !== undefined;

  return (
    <div
      className="app"
      onDragOver={(event) => {
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        // Only when the pointer actually leaves the window, not a child element.
        if (event.currentTarget === event.target) setDropping(false);
      }}
      onDrop={(event) => void onDrop(event)}
    >
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

        <span className="toolbar-group" role="group" aria-label="Document">
          <button type="button" onClick={() => void compress()} disabled={disabled}>
            Compress
          </button>
          <button type="button" onClick={() => void handleProtect()} disabled={disabled}>
            {info?.protected ? "Remove password" : "Protect…"}
          </button>
        </span>

        <span className="toolbar-group" role="group" aria-label="Zoom">
          <button
            type="button"
            onClick={() => stepZoom(-1)}
            disabled={disabled}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="zoom-level" data-testid="zoom-level">
            {zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`}
          </span>
          <button
            type="button"
            onClick={() => stepZoom(1)}
            disabled={disabled}
            aria-label="Zoom in"
          >
            +
          </button>
          <button type="button" onClick={() => setZoom("fit")} disabled={disabled}>
            Fit
          </button>
        </span>

        <form
          className="toolbar-group search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSearch();
          }}
        >
          <input
            ref={searchInput}
            type="search"
            aria-label="Search the document"
            placeholder="Search…"
            value={query}
            data-testid="search-input"
            onChange={(event) => setQuery(event.target.value)}
            disabled={disabled}
          />
          <button type="submit" disabled={disabled || query.trim() === ""}>
            Find
          </button>
          {hits.length > 0 ? (
            <>
              <span data-testid="hit-count">
                {hitIndex + 1} of {hits.length}
                {truncated ? "+" : ""}
              </span>
              <button type="button" aria-label="Previous match" onClick={() => step(-1)}>
                ‹
              </button>
              <button type="button" aria-label="Next match" onClick={() => step(1)}>
                ›
              </button>
            </>
          ) : null}
        </form>

        <span className="toolbar-name">{state.name ?? "No document open"}</span>
        {info ? (
          <span className="toolbar-pages">
            {pageCount} {pageCount === 1 ? "page" : "pages"}
            {positions.length > 0 ? `, ${positions.length} selected` : ""}
          </span>
        ) : null}
        {info?.repaired ? (
          <span className="badge" data-testid="repaired-badge" title="This file was damaged">
            Repaired
          </span>
        ) : null}
        {info?.protected ? (
          <span className="badge" data-testid="protected-badge">
            Password set
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

      {state.needsPassword ? (
        <form
          className="prompt"
          data-testid="password-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            const field = new FormData(event.currentTarget).get("password");
            if (typeof field === "string" && field !== "") void unlock(field);
          }}
        >
          <label htmlFor="password">
            <strong>{state.needsPassword}</strong> needs a password to open. It is used here on this
            device only.
          </label>
          <input id="password" name="password" type="password" autoFocus data-testid="password" />
          <button type="submit">Unlock</button>
        </form>
      ) : null}

      {askProtect ? (
        <form
          className="prompt"
          data-testid="protect-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            const field = new FormData(event.currentTarget).get("newPassword");
            if (typeof field === "string" && field !== "") {
              void protect(field);
              setAskProtect(false);
            }
          }}
        >
          <label htmlFor="newPassword">
            Password for the saved file. Keep it safe — a protected PDF cannot be recovered without
            it.
          </label>
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            autoFocus
            data-testid="new-password"
          />
          <button type="submit">Set password</button>
          <button type="button" onClick={() => setAskProtect(false)}>
            Cancel
          </button>
        </form>
      ) : null}

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
              zoom={zoom}
              highlights={highlights}
              active={activeHighlight}
              scrollTo={hits[hitIndex]?.position}
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
          <p className="empty-hint">Drop a PDF anywhere on this window, or use Open.</p>
          <p className="empty-hint">
            Click a page thumbnail to select it; shift-click to select more. Rotate, delete and
            extract act on the selection, or on the whole document when nothing is selected.
          </p>
        </main>
      )}
      {dropping ? (
        <div className="dropzone" data-testid="dropzone">
          {info ? "Drop to merge into this document" : "Drop to open"}
        </div>
      ) : null}
    </div>
  );
}

/** Zoom steps, in points per CSS pixel. */
const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
