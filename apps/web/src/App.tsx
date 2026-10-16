import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CommentList,
  FormPanel,
  Outline,
  pagesAt,
  removePages,
  Thumbnails,
  Viewer,
  type AnnotationTool,
  type Highlight,
  type PlacedShape,
} from "@pdf-suite/ui";
import { isSupportedImage, type AnnotColor, type AnnotRect } from "@pdf-suite/core";
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
    splitAt,
    openImages,
    exportImages,
    runOcr,
    applyForm,
    redact,
    addAnnotation,
    removeAnnotation,
    clearAnnotations,
    pageText,
    setOrder,
  } = useDocument();
  const openInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const mergeInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [saved, setSaved] = useState<string | undefined>();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [askProtect, setAskProtect] = useState(false);
  const [tool, setTool] = useState<AnnotationTool | undefined>();
  const [sidebar, setSidebar] = useState<"pages" | "outline" | "form" | "comments">("pages");
  const [colour, setColour] = useState<AnnotColor>(COLOURS[0]!.value);
  const [fieldValues, setFieldValues] = useState<Record<string, string | string[] | boolean>>({});
  /** Areas marked for redaction, by source page, before they are applied. */
  const [redactions, setRedactions] = useState<Map<number, AnnotRect[]>>(new Map());
  const [ocrLang, setOcrLang] = useState("eng");
  // On by default: speckle is the one degradation that destroys recognition, and
  // cleaning it costs about twice the time (ADR 0004).
  const [despeckle, setDespeckle] = useState(true);
  const [height, setHeight] = useState(600);
  /** A placed point waiting for its text, for the note and text tools. */
  const [pendingPoint, setPendingPoint] = useState<{ page: number; x: number; y: number } | null>(
    null,
  );
  const [zoom, setZoom] = useState<number | "fit" | "page">("fit");
  const [dropping, setDropping] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const [truncated, setTruncated] = useState(false);
  /** Display position to jump to, from a bookmark click. */
  const [goTo, setGoTo] = useState<number | undefined>();

  const info = state.info;
  const pageCount = state.order.length;

  // Pages are laid out to the available width, so track it.
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setHeight(el.clientHeight);
    });
    observer.observe(el);
    setWidth(el.clientWidth);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const stepZoom = useCallback((by: number) => {
    setZoom((current) => {
      // A fit mode is roughly a page width, so stepping away from it starts at 100%.
      const from =
        typeof current === "number" ? ZOOM_LEVELS.indexOf(current) : ZOOM_LEVELS.indexOf(1);
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
    setFieldValues({});
    setRedactions(new Map());
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

  const name0 = state.name ?? "document.pdf";
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

  const onImageInput = useCallback(
    async (files: FileList | null) => openImages(await readFiles(files ?? [])),
    [openImages],
  );

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
      const files = Array.from(event.dataTransfer.files);
      const pdfs = files.filter(
        (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
      );
      const images = files.filter((file) => isSupportedImage(file.type || file.name));

      // Images become a document of their own; mixing the two in one drop is
      // ambiguous, so PDFs win and the images are ignored rather than guessed at.
      if (pdfs.length === 0 && images.length > 0) {
        await openImages(await readFiles(images));
        return;
      }
      if (pdfs.length === 0) return;
      const picked = await readFiles(pdfs);
      if (!info) {
        if (picked[0]) await open(picked[0]);
        return;
      }
      await mergeIn(picked);
    },
    [info, mergeIn, open, openImages],
  );

  const handleSave = useCallback(async () => {
    const bytes = await save(state.order);
    if (!bytes) return;
    // Anything but the untouched document is a different document, so it must
    // not silently overwrite the file that was opened.
    const edited = !state.handle || state.order.length !== info?.pageCount;
    const written = await saveBytes(
      bytes,
      edited ? suffixName(name0, "edited") : name0,
      edited ? undefined : state.handle,
    );
    setSaved(written ? `Saved ${written}` : undefined);
  }, [info?.pageCount, name0, save, state.handle, state.order]);

  const handleExtract = useCallback(async () => {
    const pages = pagesAt(state.order, positions);
    const bytes = await extract(pages);
    if (!bytes) return;
    const written = await saveBytes(bytes, suffixName(name0, `${pages.length} pages`));
    setSaved(written ? `Saved ${written}` : undefined);
  }, [extract, name0, positions, state.order]);

  /** Each selected page starts a new part; every part is saved in turn. */
  const handleSplit = useCallback(async () => {
    const parts = await splitAt(positions);
    if (!parts) return;
    let written = 0;
    for (const [index, part] of parts.entries()) {
      const name = suffixName(name0, `part ${index + 1}`);
      // One dialog per part. A single archive would be friendlier, but a zip
      // writer is a dependency we do not need yet.
      if (await saveBytes(part, name)) written++;
      else break;
    }
    setSaved(written > 0 ? `Saved ${written} of ${parts.length} parts` : undefined);
  }, [name0, positions, splitAt]);

  const handleForm = useCallback(
    async (flatten: boolean) => {
      if (Object.keys(fieldValues).length === 0 && !flatten) return;
      if (await applyForm(fieldValues, flatten)) {
        setFieldValues({});
        setSaved(flatten ? "Form flattened" : "Form values written");
      }
    },
    [applyForm, fieldValues],
  );

  const redactionCount = useMemo(
    () => [...redactions.values()].reduce((n, rects) => n + rects.length, 0),
    [redactions],
  );

  /**
   * Applies the marked redactions. The result is reported in full, including a
   * failed verification — a redaction the user believes happened but did not is
   * the worst possible outcome.
   */
  const handleRedact = useCallback(async () => {
    const areas = [...redactions.entries()].map(([page, rects]) => ({ page, rects }));
    if (areas.length === 0) return;
    const result = await redact(areas);
    if (!result) return;
    setRedactions(new Map());
    const removed = Object.values(result.removed).reduce((n, c) => n + c, 0);
    setSaved(
      result.verified
        ? `Removed ${removed} object${removed === 1 ? "" : "s"}; no text left in the redacted areas`
        : `WARNING: text is still present after redacting (${result.leftovers.length} run${
            result.leftovers.length === 1 ? "" : "s"
          }). Do not share this file.`,
    );
  }, [redact, redactions]);

  /** Runs OCR over the selection, or the whole document when nothing is selected. */
  const handleOcr = useCallback(async () => {
    const wanted = positions.length > 0 ? positions : state.order.map((_, i) => i);
    // Indic pages usually carry English too, so pair the script with eng.
    const languages = ocrLang === "eng" ? ["eng"] : [ocrLang, "eng"];
    const result = await runOcr(wanted, languages, despeckle);
    if (!result) return;
    setSaved(
      `Read ${result.recognised} page${result.recognised === 1 ? "" : "s"}` +
        (result.skipped > 0 ? `, skipped ${result.skipped} that already had text` : ""),
    );
  }, [despeckle, ocrLang, positions, runOcr, state.order]);

  /** Writes the selected pages, or the whole document, as PNG files. */
  const handleExportImages = useCallback(async () => {
    const wanted = positions.length > 0 ? positions : state.order.map((_, i) => i);
    const rendered = await exportImages(wanted);
    if (!rendered) return;
    let written = 0;
    for (const image of rendered) {
      const name = `${stripPdf(name0)} page ${image.position + 1}.png`;
      if (await saveBytes(image.bytes, name, undefined, "image/png")) written++;
      else break;
    }
    setSaved(written > 0 ? `Saved ${written} image${written === 1 ? "" : "s"}` : undefined);
  }, [exportImages, name0, positions, state.order]);

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

  /**
   * A dragged box becomes a mark of whichever quad-based tool is active. It is
   * snapped to the text lines it crosses when the page has a text layer, so a
   * rough drag produces tidy line-aligned marks; on a scan with no text layer it
   * stays as drawn.
   */
  const placeMarkup = useCallback(
    async (page: number, rect: AnnotRect, kind: "highlight" | "underline" | "strike") => {
      const runs = await pageText(page);
      const overlapping = runs
        .filter(
          (r) =>
            r.x < rect.x + rect.w &&
            r.x + r.w > rect.x &&
            r.y < rect.y + rect.h &&
            r.y + r.h > rect.y,
        )
        .map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
      addAnnotation({
        kind,
        page,
        rects: overlapping.length > 0 ? overlapping : [rect],
        // A highlight keeps its yellow tint; a line takes the chosen colour.
        ...(kind === "highlight" ? {} : { color: colour }),
      });
    },
    [addAnnotation, colour, pageText],
  );

  const onPlace = useCallback(
    (page: number, shape: PlacedShape) => {
      if (shape.kind === "stroke") {
        addAnnotation({ kind: "ink", page, strokes: [shape.points], color: colour });
        return;
      }
      if (shape.kind === "rect") {
        if (tool === "square" || tool === "circle") {
          addAnnotation({ kind: tool, page, ...shape.rect, color: colour });
          return;
        }
        if (tool === "redact") {
          setRedactions((current) => {
            const next = new Map(current);
            next.set(page, [...(next.get(page) ?? []), shape.rect]);
            return next;
          });
          return;
        }
        if (tool === "highlight" || tool === "underline" || tool === "strike") {
          void placeMarkup(page, shape.rect, tool);
        }
        return;
      }
      // A note or a text box needs its words before it is worth creating.
      setPendingPoint({ page, x: shape.x, y: shape.y });
    },
    [addAnnotation, colour, placeMarkup, tool],
  );

  const commitPending = useCallback(
    (contents: string) => {
      const point = pendingPoint;
      setPendingPoint(null);
      if (!point || contents.trim() === "") return;
      if (tool === "note") {
        addAnnotation({
          kind: "note",
          page: point.page,
          x: point.x,
          y: point.y,
          contents,
          color: colour,
        });
        return;
      }
      // Roughly fit the box to the text; the viewer wraps what does not fit.
      const size = 12;
      addAnnotation({
        kind: "text",
        page: point.page,
        x: point.x,
        y: point.y,
        w: Math.min(360, Math.max(80, contents.length * size * 0.55)),
        h: size * 1.6 * Math.ceil(contents.length / 60),
        contents,
        size,
        color: colour,
      });
    },
    [addAnnotation, colour, pendingPoint, tool],
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
          <button
            type="button"
            onClick={() => void handleSplit()}
            disabled={disabled || positions.length === 0}
            title="Each selected page starts a new file"
            data-testid="split"
          >
            Split…
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

        <span className="toolbar-group" role="group" aria-label="Images">
          <button
            type="button"
            onClick={() => imageInput.current?.click()}
            disabled={!ready}
            data-testid="images-to-pdf"
            title="Turn JPEG or PNG files into a PDF"
          >
            From images…
          </button>
          <button
            type="button"
            onClick={() => void handleExportImages()}
            disabled={disabled}
            data-testid="pages-to-images"
            title="Save the selected pages, or all of them, as PNG"
          >
            To images…
          </button>
        </span>

        <span className="toolbar-group" role="group" aria-label="Text recognition">
          <label className="visually-hidden" htmlFor="ocr-lang">
            OCR language
          </label>
          <select
            id="ocr-lang"
            value={ocrLang}
            onChange={(event) => setOcrLang(event.target.value)}
            disabled={disabled}
            data-testid="ocr-lang"
          >
            <option value="eng">English</option>
            <option value="mal">Malayalam</option>
            <option value="hin">Hindi</option>
          </select>
          <button
            type="button"
            onClick={() => void handleOcr()}
            disabled={disabled}
            data-testid="run-ocr"
            title="Make scanned pages searchable. Downloads the language pack once."
          >
            Recognise text
          </button>
          <label
            className="toolbar-check"
            title="Removes scanner speckle before reading the page. Without it, a noisy scan can come back empty."
          >
            <input
              type="checkbox"
              checked={despeckle}
              onChange={(event) => setDespeckle(event.target.checked)}
              disabled={disabled}
              data-testid="ocr-despeckle"
            />
            Clean up
          </label>
        </span>

        <span className="toolbar-group" role="group" aria-label="Annotate">
          {(
            [
              "highlight",
              "underline",
              "strike",
              "note",
              "text",
              "square",
              "circle",
              "ink",
              "redact",
            ] as const
          ).map((which) => (
            <button
              key={which}
              type="button"
              className={tool === which ? "tool tool-active" : "tool"}
              aria-pressed={tool === which}
              disabled={disabled}
              data-testid={`tool-${which}`}
              onClick={() => {
                setTool((current) => (current === which ? undefined : which));
                setPendingPoint(null);
              }}
            >
              {TOOL_LABELS[which]}
            </button>
          ))}
          <span className="swatches" role="group" aria-label="Colour">
            {COLOURS.map((option) => (
              <button
                key={option.name}
                type="button"
                className={colour === option.value ? "swatch swatch-active" : "swatch"}
                style={{
                  background: `rgb(${option.value.map((c) => Math.round(c * 255)).join(" ")})`,
                }}
                aria-label={option.name}
                aria-pressed={colour === option.value}
                data-testid={`colour-${option.name}`}
                disabled={disabled}
                onClick={() => setColour(option.value)}
              />
            ))}
          </span>
          {redactionCount > 0 ? (
            <button
              type="button"
              onClick={() => void handleRedact()}
              disabled={disabled}
              data-testid="apply-redaction"
              title="Remove the marked content from the document, permanently"
            >
              Remove {redactionCount} area{redactionCount === 1 ? "" : "s"}
            </button>
          ) : null}
          {state.annotations.length > 0 ? (
            <button
              type="button"
              onClick={clearAnnotations}
              data-testid="clear-annotations"
              title="Remove every annotation not yet saved"
            >
              Clear {state.annotations.length}
            </button>
          ) : null}
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
            {zoom === "fit" ? "Fit" : zoom === "page" ? "Page" : `${Math.round(zoom * 100)}%`}
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
          <button
            type="button"
            onClick={() => setZoom("page")}
            disabled={disabled}
            data-testid="fit-page"
          >
            Page
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
        ref={imageInput}
        type="file"
        accept="image/jpeg,image/png,.jpg,.jpeg,.png"
        multiple
        data-testid="image-input"
        className="visually-hidden"
        onChange={(event) => void onImageInput(event.target.files)}
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

      {pendingPoint ? (
        <form
          className="prompt"
          data-testid="annotation-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            const field = new FormData(event.currentTarget).get("contents");
            commitPending(typeof field === "string" ? field : "");
          }}
        >
          <label htmlFor="contents">
            {tool === "note" ? "Note text" : "Text to add to the page"}
          </label>
          <input id="contents" name="contents" autoFocus data-testid="annotation-text" />
          <button type="submit">Place</button>
          <button type="button" onClick={() => setPendingPoint(null)}>
            Cancel
          </button>
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
          <div className="sidebar">
            <div className="sidebar-tabs" role="tablist" aria-label="Sidebar">
              <button
                type="button"
                role="tab"
                aria-selected={sidebar === "pages"}
                className={sidebar === "pages" ? "tab tab-active" : "tab"}
                onClick={() => setSidebar("pages")}
              >
                Pages
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sidebar === "comments"}
                className={sidebar === "comments" ? "tab tab-active" : "tab"}
                data-testid="tab-comments"
                onClick={() => setSidebar("comments")}
              >
                Marks{state.annotations.length > 0 ? ` (${state.annotations.length})` : ""}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sidebar === "form"}
                className={sidebar === "form" ? "tab tab-active" : "tab"}
                data-testid="tab-form"
                onClick={() => setSidebar("form")}
              >
                Form{info.form.fields.length > 0 ? ` (${info.form.fields.length})` : ""}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sidebar === "outline"}
                className={sidebar === "outline" ? "tab tab-active" : "tab"}
                data-testid="tab-outline"
                onClick={() => setSidebar("outline")}
              >
                Bookmarks{info.outline.length > 0 ? ` (${info.outline.length})` : ""}
              </button>
            </div>
            {sidebar === "comments" ? (
              <div className="sidebar-scroll">
                <CommentList
                  annotations={state.annotations}
                  positionOf={(page) => {
                    const at = state.order.indexOf(page);
                    return at >= 0 ? at : page;
                  }}
                  onGo={(page) => {
                    const at = state.order.indexOf(page);
                    if (at >= 0) setGoTo(at);
                  }}
                  onRemove={removeAnnotation}
                />
              </div>
            ) : sidebar === "form" ? (
              <div className="sidebar-scroll">
                <FormPanel
                  form={info.form}
                  values={fieldValues}
                  onChange={(name, value) =>
                    setFieldValues((current) => ({ ...current, [name]: value }))
                  }
                  onGo={(page) => {
                    const position = state.order.indexOf(page);
                    if (position >= 0) setGoTo(position);
                  }}
                />
                {info.form.fields.length > 0 ? (
                  <div className="form-actions">
                    <button
                      type="button"
                      onClick={() => void handleForm(false)}
                      disabled={disabled || Object.keys(fieldValues).length === 0}
                      data-testid="apply-form"
                    >
                      Write values
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleForm(true)}
                      disabled={disabled}
                      data-testid="flatten-form"
                      title="Write the values in and remove the fields, so they cannot be changed"
                    >
                      Flatten
                    </button>
                  </div>
                ) : null}
              </div>
            ) : sidebar === "pages" ? (
              <Thumbnails
                order={state.order}
                pageSizes={info.pageSizes}
                render={render}
                onReorder={setOrder}
                selected={selected}
                onSelect={onSelect}
              />
            ) : (
              <Outline
                items={info.outline}
                onGo={(page) => {
                  // Bookmarks name source pages; the viewer scrolls by position.
                  const position = state.order.indexOf(page);
                  if (position >= 0) setGoTo(position);
                }}
              />
            )}
          </div>
          <div className="main" ref={main}>
            <Viewer
              order={state.order}
              pageSizes={info.pageSizes}
              render={render}
              containerWidth={width}
              containerHeight={height}
              pixelRatio={globalThis.devicePixelRatio || 1}
              zoom={zoom}
              highlights={highlights}
              active={activeHighlight}
              scrollTo={goTo ?? hits[hitIndex]?.position}
              annotations={state.annotations}
              tool={tool}
              redactions={redactions}
              onPlace={onPlace}
              onRemoveAnnotation={tool === undefined ? removeAnnotation : undefined}
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
          {info ? "Drop a PDF to merge, or images to convert" : "Drop a PDF or images"}
        </div>
      ) : null}
    </div>
  );
}

const TOOL_LABELS: Record<AnnotationTool, string> = {
  highlight: "Highlight",
  underline: "Underline",
  strike: "Strike",
  note: "Note",
  text: "Add text",
  square: "Box",
  circle: "Oval",
  ink: "Draw",
  redact: "Redact",
};

/** A small fixed palette: a full picker is a dialog nobody asked for. */
const COLOURS: { name: string; value: AnnotColor }[] = [
  { name: "red", value: [0.85, 0.15, 0.15] },
  { name: "blue", value: [0.15, 0.35, 0.85] },
  { name: "green", value: [0.1, 0.55, 0.25] },
  { name: "black", value: [0, 0, 0] },
];

function stripPdf(name: string): string {
  return name.replace(/\.pdf$/i, "");
}

/** Zoom steps, in points per CSS pixel. */
const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
