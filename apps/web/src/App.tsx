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
  ContextMenu,
  type MenuItem,
  type TextEditCommit,
} from "@pdf-suite/ui";
import type { NumberFormat, Slots } from "@pdf-suite/workers";
import { isSupportedImage, type AnnotColor, type AnnotRect } from "@pdf-suite/core";
import type { EditableText, SearchHit } from "@pdf-suite/workers";
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
    editableText,
    editText,
    addAnnotation,
    removeAnnotation,
    clearAnnotations,
    stamp,
    pageText,
    setOrder,
    undo,
    redo,
    canUndo,
    canRedo,
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
  /** Headers, footers and page numbers, Acrobat's six slots. */
  const [numbering, setNumbering] = useState(false);
  const [header, setHeader] = useState<Slots>(["", "", ""]);
  const [footer, setFooter] = useState<Slots>(["", "Page {n} of {total}", ""]);
  /** Which slot a token button writes into: the one last typed in. */
  const [slot, setSlot] = useState<["header" | "footer", number]>(["footer", 1]);
  const [numberFormat, setNumberFormat] = useState<NumberFormat>("1");
  const [startAt, setStartAt] = useState(1);
  const [digits, setDigits] = useState(0);
  const [stampSize, setStampSize] = useState(10);
  const [stampMargin, setStampMargin] = useState(36);

  /** Right-click menu: where it is, and which page it was opened on. */
  const [menu, setMenu] = useState<{ x: number; y: number; position: number } | null>(null);
  const [tool, setTool] = useState<AnnotationTool | undefined>();
  /** Edit-text mode, which is a different thing from the annotation tools. */
  const [editingText, setEditingText] = useState(false);
  const [editRuns, setEditRuns] = useState<Map<number, EditableText[]>>(new Map());
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

  // Positions move when pages are added, removed or reordered, so a stale
  // selection or a stale set of hits would point at the wrong pages.
  useEffect(() => {
    setFieldValues({});
    setEditRuns(new Map());
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

  const handleFromImages = useCallback(async () => {
    if (!canUsePicker()) {
      imageInput.current?.click();
      return;
    }
    await openImages(await pickFiles(true, true));
  }, [openImages]);

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
      "application/pdf",
      edited ? undefined : state.path,
    );
    setSaved(written ? `Saved ${written}` : undefined);
  }, [info?.pageCount, name0, save, state.handle, state.order, state.path]);

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

  const openMenu = useCallback((position: number, x: number, y: number) => {
    setSelected((current) => (current.has(position) ? current : new Set([position])));
    setMenu({ x, y, position });
  }, []);

  const handleDelete = useCallback(() => {
    if (positions.length === 0 || positions.length === pageCount) return;
    setOrder(removePages(state.order, positions));
    setSelected(new Set());
  }, [pageCount, positions, setOrder, state.order]);

  // Ctrl/Cmd+F goes to our search, not the browser's, which cannot see inside a
  // canvas anyway. The rest are the ones every editor has — open, save, undo,
  // redo, zoom, and Delete for the pages that are selected.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      // Never while typing: Delete in a text box means delete a character.
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");

      if (!meta && !typing && (event.key === "Delete" || event.key === "Backspace")) {
        if (positions.length === 0 || positions.length === pageCount) return;
        event.preventDefault();
        handleDelete();
        return;
      }
      if (meta && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
        return;
      }
      if (!meta) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        void (event.shiftKey ? redo() : undo());
        return;
      }
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void handleOpen();
        return;
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSave();
        return;
      }
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
  }, [handleDelete, handleOpen, handleSave, pageCount, positions.length, redo, stepZoom, undo]);

  const handleStamp = useCallback(async () => {
    const applied = await stamp({
      header,
      footer,
      fontSize: stampSize,
      margin: stampMargin,
      startAt,
      digits,
      format: numberFormat,
      name: name0,
      // Numbering a selection is Acrobat's "Page Range"; no selection means all.
      ...(positions.length > 0 ? { pages: positions } : {}),
    });
    if (!applied) return;
    setNumbering(false);
    setSaved(
      positions.length > 0
        ? `Numbered ${positions.length} ${positions.length === 1 ? "page" : "pages"}`
        : "Headers and footers added",
    );
  }, [
    digits,
    footer,
    header,
    name0,
    numberFormat,
    positions,
    stamp,
    stampMargin,
    stampSize,
    startAt,
  ]);

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

  /** Reads a page's editable runs once, when it first comes into view. */
  const needEditableText = useCallback(
    (page: number) => {
      setEditRuns((current) => {
        if (current.has(page)) return current;
        // Mark it in flight before awaiting, or a second scroll asks again.
        const next = new Map(current);
        next.set(page, []);
        void editableText(page).then((runs) =>
          setEditRuns((later) => new Map(later).set(page, runs)),
        );
        return next;
      });
    },
    [editableText],
  );

  const handleEditText = useCallback(
    async (page: number, edit: TextEditCommit) => {
      const result = await editText([{ page, ...edit }]);
      if (!result) return;
      setEditRuns(new Map());
      setSaved(editOutcome(result));
    },
    [editText],
  );

  /** What a right-click on a page offers: the page actions, where the page is. */
  const many = positions.length > 1 ? ` ${positions.length} pages` : "";
  const pageMenuItems: MenuItem[] = [
    { label: `Rotate${many || " page"} left`, onSelect: () => void rotatePages(target, 270) },
    { label: `Rotate${many || " page"} right`, onSelect: () => void rotatePages(target, 90) },
    { label: "Insert a PDF after this page…", onSelect: () => void handleMerge() },
    { label: `Extract${many || " page"}…`, onSelect: () => void handleExtract() },
    { label: `Save${many || " page"} as an image…`, onSelect: () => void handleExportImages() },
    {
      label: `Delete${many || " page"}`,
      onSelect: handleDelete,
      danger: true,
      disabled: positions.length === pageCount,
    },
  ];

  const status = state.error ?? state.busy ?? saved;
  const disabled = !ready || !info || state.busy !== undefined;

  /** One tool button in the right-hand panel. */
  const toolButton = (which: AnnotationTool) => (
    <button
      key={which}
      type="button"
      className={tool === which ? "tool tool-on" : "tool"}
      aria-pressed={tool === which}
      disabled={disabled}
      data-testid={`tool-${which}`}
      title={TOOL_HINTS[which]}
      onClick={() => {
        setTool((current) => (current === which ? undefined : which));
        setPendingPoint(null);
        setEditingText(false);
      }}
    >
      <span className="tool-icon" aria-hidden="true">
        {TOOL_ICONS[which]}
      </span>
      <span className="tool-name">{TOOL_LABELS[which]}</span>
    </button>
  );

  const action = (
    label: string,
    onClick: () => void,
    options: {
      testId?: string;
      hint?: string;
      off?: boolean;
      danger?: boolean;
      /** When the visible label is a glyph, the name assistive tech reads. */
      name?: string;
    } = {},
  ) => (
    <button
      type="button"
      className={options.danger ? "action action-danger" : "action"}
      onClick={onClick}
      disabled={options.off ?? disabled}
      {...(options.testId ? { "data-testid": options.testId } : {})}
      {...(options.name ? { "aria-label": options.name } : {})}
      title={options.hint ?? options.name ?? label}
    >
      {label}
    </button>
  );

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
      <header className="topbar">
        <div className="brand">
          <BrandMark className="brand-mark" />
          <span className="brand-words">
            <span className="brand-name">PDF Suite</span>
            <span className="brand-lab">FACTS-H Lab</span>
          </span>
        </div>

        <div className="topbar-file">
          {action("Open", () => void handleOpen(), { off: !ready, hint: "Open a PDF (⌘O)" })}
          {info
            ? action(
                positions.length === 1 ? "Insert after…" : "Merge…",
                () => void handleMerge(),
                {
                  hint: "Add another PDF to this one",
                },
              )
            : null}
          {info
            ? action("Save", () => void handleSave(), { hint: "Save the document (⌘S)" })
            : null}
          {info ? (
            <span className="topbar-history">
              {action("↶", () => void undo(), {
                testId: "undo",
                name: "Undo",
                hint: "Undo the last change (⌘Z)",
                off: disabled || !canUndo,
              })}
              {action("↷", () => void redo(), {
                testId: "redo",
                name: "Redo",
                hint: "Redo the change just undone (⇧⌘Z)",
                off: disabled || !canRedo,
              })}
            </span>
          ) : null}
        </div>

        {info ? (
          <form
            className="search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSearch();
            }}
          >
            <span className="search-icon" aria-hidden="true">
              ⌕
            </span>
            <input
              ref={searchInput}
              type="search"
              aria-label="Search the document"
              placeholder="Search this document"
              value={query}
              data-testid="search-input"
              onChange={(event) => setQuery(event.target.value)}
              disabled={disabled}
            />
            <button type="submit" className="search-go" disabled={disabled || query.trim() === ""}>
              Find
            </button>
            {hits.length > 0 ? (
              <span className="search-nav">
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
              </span>
            ) : null}
          </form>
        ) : null}

        <div className="topbar-doc">
          <span className="doc-name">{state.name ?? "No document open"}</span>
          {info ? (
            <span className="doc-meta">
              {pageCount} {pageCount === 1 ? "page" : "pages"}
              {positions.length > 0 ? ` · ${positions.length} selected` : ""}
            </span>
          ) : null}
          {info?.repaired ? (
            <span
              className="badge"
              data-testid="repaired-badge"
              title="This file was damaged and was rebuilt"
            >
              Repaired
            </span>
          ) : null}
          {info?.protected ? (
            <span className="badge badge-lock" data-testid="protected-badge">
              Password set
            </span>
          ) : null}
        </div>
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
            <strong>{state.needsPassword}</strong> needs a password. It is used here on this device
            only.
          </label>
          <input id="password" name="password" type="password" autoFocus data-testid="password" />
          <button type="submit" className="action action-go">
            Unlock
          </button>
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
          <button type="submit" className="action action-go">
            Place
          </button>
          <button type="button" className="action" onClick={() => setPendingPoint(null)}>
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
            Password for the saved file. Keep it safe — a protected PDF cannot be opened without it.
          </label>
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            autoFocus
            data-testid="new-password"
          />
          <button type="submit" className="action action-go">
            Set password
          </button>
          <button type="button" className="action" onClick={() => setAskProtect(false)}>
            Cancel
          </button>
        </form>
      ) : null}

      {numbering && info ? (
        <form
          className="prompt hfpanel"
          data-testid="numbering-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void handleStamp();
          }}
        >
          <div className="hfgrid">
            {(["header", "footer"] as const).map((band) => (
              <div className="hfrow" key={band}>
                <span className="hflabel">{band === "header" ? "Header" : "Footer"}</span>
                {[0, 1, 2].map((which) => (
                  <input
                    key={which}
                    type="text"
                    className="hfslot"
                    data-testid={`${band}-${which}`}
                    aria-label={`${band} ${["left", "centre", "right"][which]}`}
                    placeholder={["left", "centre", "right"][which]}
                    value={(band === "header" ? header : footer)[which]}
                    onFocus={() => setSlot([band, which])}
                    onChange={(event) => {
                      const next = [...(band === "header" ? header : footer)] as Slots;
                      next[which] = event.target.value;
                      (band === "header" ? setHeader : setFooter)(next);
                    }}
                  />
                ))}
              </div>
            ))}
          </div>

          <div className="hfrow hftokens">
            <span className="hflabel">Insert</span>
            {TOKENS.map(({ token, label }) => (
              <button
                key={token}
                type="button"
                className="action"
                data-testid={`token-${token.replace(/[{}]/g, "")}`}
                title={`Add ${label} to the ${slot[0]} ${["left", "centre", "right"][slot[1]]} box`}
                onClick={() => {
                  const [band, which] = slot;
                  const next = [...(band === "header" ? header : footer)] as Slots;
                  next[which] = `${next[which]}${next[which] ? " " : ""}${token}`;
                  (band === "header" ? setHeader : setFooter)(next);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="hfrow hfoptions">
            <label>
              Start at
              <input
                type="number"
                min={0}
                value={startAt}
                data-testid="start-at"
                onChange={(event) => setStartAt(event.target.valueAsNumber || 0)}
              />
            </label>
            <label>
              Style
              <select
                value={numberFormat}
                data-testid="number-format"
                onChange={(event) => setNumberFormat(event.target.value as NumberFormat)}
              >
                <option value="1">1, 2, 3</option>
                <option value="i">i, ii, iii</option>
                <option value="I">I, II, III</option>
                <option value="a">a, b, c</option>
                <option value="A">A, B, C</option>
              </select>
            </label>
            <label title="Zero-pads the number, which is what Bates numbering is: ACME-000001">
              Pad to
              <input
                type="number"
                min={0}
                max={12}
                value={digits}
                data-testid="pad-digits"
                onChange={(event) => setDigits(event.target.valueAsNumber || 0)}
              />
              digits
            </label>
            <label>
              Size
              <input
                type="number"
                min={4}
                max={48}
                value={stampSize}
                onChange={(event) => setStampSize(event.target.valueAsNumber || 10)}
              />
              pt
            </label>
            <label>
              Margin
              <input
                type="number"
                min={0}
                max={200}
                value={stampMargin}
                onChange={(event) => setStampMargin(event.target.valueAsNumber || 36)}
              />
              pt
            </label>
          </div>

          <div className="hfrow">
            <span className="hfnote">
              {positions.length > 0
                ? `Applies to the ${positions.length} selected ${positions.length === 1 ? "page" : "pages"}.`
                : "Applies to every page."}{" "}
              Bates numbering is a prefix and padding — type <code>ACME-{"{n}"}</code> and pad to 6.
            </span>
            <button type="submit" className="action action-go" data-testid="apply-numbering">
              Add
            </button>
            <button type="button" className="action" onClick={() => setNumbering(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {info ? (
        <div className="workspace">
          <aside className="sidebar">
            <div className="sidebar-tabs" role="tablist" aria-label="Sidebar">
              {(
                [
                  ["pages", "Pages", undefined],
                  ["comments", "Marks", state.annotations.length],
                  ["form", "Form", info.form.fields.length],
                  ["outline", "Marks", info.outline.length],
                ] as const
              ).map(([key, label, count], index) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={sidebar === key}
                  className={sidebar === key ? "tab tab-on" : "tab"}
                  {...(key === "pages" ? {} : { "data-testid": `tab-${key}` })}
                  onClick={() => setSidebar(key)}
                >
                  {index === 3 ? "Bookmarks" : label}
                  {count ? <span className="tab-count">{count}</span> : null}
                </button>
              ))}
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
                  <div className="panel-actions">
                    {action("Write values", () => void handleForm(false), {
                      testId: "apply-form",
                      off: disabled || Object.keys(fieldValues).length === 0,
                    })}
                    {action("Flatten", () => void handleForm(true), {
                      testId: "flatten-form",
                      hint: "Write the values in and remove the fields",
                    })}
                  </div>
                ) : null}
              </div>
            ) : sidebar === "outline" ? (
              <Outline
                items={info.outline}
                onGo={(page) => {
                  const position = state.order.indexOf(page);
                  if (position >= 0) setGoTo(position);
                }}
              />
            ) : (
              <Thumbnails
                order={state.order}
                pageSizes={info.pageSizes}
                render={render}
                onReorder={setOrder}
                selected={selected}
                onSelect={onSelect}
                onPageMenu={openMenu}
              />
            )}
          </aside>

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
              editing={editingText}
              editableText={editRuns}
              onNeedEditableText={needEditableText}
              onEditText={(page, edit) => void handleEditText(page, edit)}
              onPageMenu={openMenu}
            />
          </div>

          <aside className="tools" aria-label="Tools">
            <section className="tool-group">
              <h2>Edit</h2>
              <button
                type="button"
                className={editingText ? "edit-toggle edit-toggle-on" : "edit-toggle"}
                aria-pressed={editingText}
                disabled={disabled}
                data-testid="edit-text"
                onClick={() => {
                  setEditingText((on) => !on);
                  setTool(undefined);
                  setEditRuns(new Map());
                }}
              >
                <span className="tool-icon" aria-hidden="true">
                  ✎
                </span>
                <span>
                  <strong>Edit text</strong>
                  <small>Click a paragraph on the page and type over it</small>
                </span>
              </button>
              {editingText ? (
                <p className="tool-hint" data-testid="edit-caveat">
                  Changes the words in the document itself. A paragraph re-wraps to its own width; a
                  character the embedded font lacks is set in Helvetica instead.
                </p>
              ) : null}
            </section>

            <section className="tool-group">
              <h2>Annotate</h2>
              <div className="tool-grid">
                {(["highlight", "underline", "strike", "note", "text"] as const).map(toolButton)}
              </div>
              <div className="tool-grid">
                {(["square", "circle", "ink"] as const).map(toolButton)}
              </div>
              <div className="tool-options">
                <span className="tool-options-label">Colour</span>
                <span className="swatches" role="group" aria-label="Colour">
                  {COLOURS.map((option) => (
                    <button
                      key={option.name}
                      type="button"
                      className={colour === option.value ? "swatch swatch-on" : "swatch"}
                      style={{
                        background: `rgb(${option.value.map((c) => Math.round(c * 255)).join(" ")})`,
                      }}
                      aria-label={option.name}
                      aria-pressed={colour === option.value}
                      data-testid={`colour-${option.name}`}
                      onClick={() => setColour(option.value)}
                    />
                  ))}
                </span>
              </div>
              {state.annotations.length > 0
                ? action(`Clear ${state.annotations.length} marks`, clearAnnotations, {
                    testId: "clear-annotations",
                    danger: true,
                  })
                : null}
            </section>

            <section className="tool-group">
              <h2>Pages</h2>
              <p className="tool-hint">
                {positions.length > 0
                  ? `${positions.length} selected`
                  : "Nothing selected — acts on the whole document"}
              </p>
              <div className="tool-grid">{toolButton("redact")}</div>
              {redactionCount > 0
                ? action(
                    `Remove ${redactionCount} area${redactionCount === 1 ? "" : "s"}`,
                    () => void handleRedact(),
                    {
                      testId: "apply-redaction",
                      danger: true,
                      hint: "Delete the marked content permanently",
                    },
                  )
                : null}
              <div className="action-row">
                {action("↺ Left", () => void rotatePages(target, 270), { name: "Rotate left" })}
                {action("↻ Right", () => void rotatePages(target, 90), { name: "Rotate right" })}
              </div>
              <div className="action-row">
                {action("Delete", handleDelete, {
                  off: disabled || positions.length === 0 || positions.length === pageCount,
                  danger: true,
                })}
                {action("Extract…", () => void handleExtract(), {
                  off: disabled || positions.length === 0,
                })}
                {action("Split…", () => void handleSplit(), {
                  testId: "split",
                  off: disabled || positions.length === 0,
                  hint: "Each selected page starts a new file",
                })}
              </div>
              <div className="action-row">
                {action("Page numbers…", () => setNumbering((open) => !open), {
                  testId: "number-pages",
                  hint: "Headers, footers, page numbers and Bates numbering",
                })}
              </div>
            </section>

            <section className="tool-group">
              <h2>Recognise text</h2>
              <p className="tool-hint">Makes a scanned page searchable.</p>
              <div className="action-row">
                <select
                  aria-label="OCR language"
                  value={ocrLang}
                  onChange={(event) => setOcrLang(event.target.value)}
                  disabled={disabled}
                  data-testid="ocr-lang"
                >
                  <option value="eng">English</option>
                  <option value="mal">Malayalam</option>
                  <option value="hin">Hindi</option>
                </select>
                {action("Run", () => void handleOcr(), { testId: "run-ocr" })}
              </div>
              <label
                className="check"
                title="Removes scanner speckle first. Without it a noisy scan can come back empty."
              >
                <input
                  type="checkbox"
                  checked={despeckle}
                  onChange={(event) => setDespeckle(event.target.checked)}
                  disabled={disabled}
                  data-testid="ocr-despeckle"
                />
                Clean up the scan first
              </label>
            </section>

            <section className="tool-group">
              <h2>Convert &amp; protect</h2>
              <div className="action-row">
                {action("From images…", () => void handleFromImages(), {
                  testId: "images-to-pdf",
                  off: !ready,
                  hint: "Turn JPEG or PNG files into a PDF",
                })}
                {action("To images…", () => void handleExportImages(), {
                  testId: "pages-to-images",
                  hint: "Save pages as PNG",
                })}
              </div>
              <div className="action-row">
                {action("Compress", () => void compress())}
                {action(
                  info.protected ? "Remove password" : "Protect…",
                  () => void handleProtect(),
                )}
              </div>
            </section>
          </aside>
        </div>
      ) : (
        <main className="empty">
          <div className="empty-card">
            <BrandMark className="empty-mark" lockup />
            <h1>Your files never leave this device</h1>
            <p>
              Open a PDF to read, mark up, reorganise, redact or sign it. Every operation runs here,
              on your computer — switch off your network and it keeps working.
            </p>
            <div className="empty-actions">
              {action("Open a PDF", () => void handleOpen(), { off: !ready })}
              {action("From images…", () => void handleFromImages(), { off: !ready })}
            </div>
            <p className="empty-hint">or drop a file anywhere on this window</p>
          </div>
        </main>
      )}

      {menu && info ? (
        <ContextMenu x={menu.x} y={menu.y} items={pageMenuItems} onClose={() => setMenu(null)} />
      ) : null}

      <footer className="statusbar">
        {info ? (
          <div className="zoom" role="group" aria-label="Zoom">
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
          </div>
        ) : (
          <span />
        )}
        <span
          className={state.error ? "status status-error" : "status"}
          role="status"
          data-testid="status"
        >
          {status ?? (ready ? "Ready" : "Starting engine…")}
        </span>
      </footer>

      {dropping ? (
        <div className="dropzone" data-testid="dropzone">
          {info ? "Drop a PDF to merge, or images to convert" : "Drop a PDF or images"}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Simple glyphs rather than an icon library. A dependency for nine marks is not
 * worth it, and these read at any size without a sprite sheet.
 */
const TOOL_ICONS: Record<AnnotationTool, string> = {
  highlight: "▬",
  underline: "U̲",
  strike: "S̶",
  note: "●",
  text: "T",
  square: "▭",
  circle: "◯",
  ink: "✎",
  redact: "█",
};

const TOOL_HINTS: Record<AnnotationTool, string> = {
  highlight: "Drag across text to highlight it",
  underline: "Drag across text to underline it",
  strike: "Drag across text to strike it through",
  note: "Click a page to leave a note",
  text: "Click a page to type on it",
  square: "Drag to draw a box",
  circle: "Drag to draw an oval",
  ink: "Draw freehand",
  redact: "Drag over content to delete it permanently",
};

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

/** What a header or footer box can hold besides the words you type. */
const TOKENS = [
  { token: "{n}", label: "Page number" },
  { token: "{total}", label: "Page count" },
  { token: "{date}", label: "Date" },
  { token: "{file}", label: "File name" },
];

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

/**
 * The FACTS-H Lab roundel. Two files rather than one: the artwork is line work
 * with a transparent background, so a dark ink is needed on a light theme and a
 * light one on a dark theme. Both are in the bundle — nothing is fetched.
 */
function BrandMark({ className, lockup = false }: { className: string; lockup?: boolean }) {
  const size = lockup ? "lockup" : "mark";
  return (
    <picture className={className}>
      <source srcSet={`/brand/${size}-light.png`} media="(prefers-color-scheme: dark)" />
      <img src={`/brand/${size}-dark.png`} alt="FACTS-H Lab" width={lockup ? 72 : 26} />
    </picture>
  );
}

/**
 * What to tell the user after editing text. Substituted fonts and lines that did
 * not fit the original block change how the page looks, so neither is left for
 * the user to discover on their own.
 */
function editOutcome(result: {
  substituted: { from: string; to: string; characters: string }[];
  addedLines: number;
  rejected: { reason: string }[];
}): string {
  const refused = result.rejected[0];
  if (refused) return `Could not change that text: ${refused.reason}`;

  const notes: string[] = [];
  const swap = result.substituted[0];
  if (swap) {
    notes.push(`${swap.from} cannot show ${swap.characters}, so ${swap.to} was used`);
  }
  if (result.addedLines > 0) {
    notes.push(
      `${result.addedLines} new ${result.addedLines === 1 ? "line" : "lines"} — check what follows`,
    );
  }
  return notes.length > 0 ? `Text changed: ${notes.join("; ")}` : "Text changed";
}
