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
  addBookmark,
  ContextMenu,
  moveAt,
  removeAt,
  renameAt,
  SignaturePad,
  type MenuItem,
  type TextEditCommit,
} from "@pdf-suite/ui";
import type { Bookmark, NumberFormat, Slots } from "@pdf-suite/workers";
import type { OutlineItem } from "@pdf-suite/engine";
import {
  area as areaOf,
  distance as distanceOf,
  formatMeasurement,
  isSupportedImage,
  perimeter,
  SCALES,
  type AnnotColor,
  type AnnotRect,
} from "@pdf-suite/core";
import type {
  AccessibilityIssue,
  Attachment,
  DocumentDiff,
  Link,
  EditableText,
  PageLabelRange,
  Found,
  PageImage,
  PatternName,
  SanitiseReport,
  SearchHit,
  TextRun,
} from "@pdf-suite/workers";
import {
  canConvertOffice,
  canUsePicker,
  convertOffice,
  OFFICE_EXTENSIONS,
  pickFiles,
  printBytes,
  readFiles,
  saveBytes,
  suffixName,
} from "./file-io.js";
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
    pageImages,
    editImages,
    addAnnotation,
    removeAnnotation,
    clearAnnotations,
    stamp,
    describe,
    extractAllText,
    crop,
    addWatermark,
    setLabels,
    markRedactions,
    applyRedactions,
    setLayers,
    links,
    addPageLink,
    exportMarks,
    importMarks,
    replyToMark,
    deleteMark,
    compare,
    attachments,
    attach,
    readAttachment,
    removeAttachment,
    addFormField,
    removeFormField,
    findPattern,
    setBookmarks,
    checkAccessible,
    fixAccessible,
    findHidden,
    sanitise,
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
  const attachInput = useRef<HTMLInputElement>(null);
  const compareInput = useRef<HTMLInputElement>(null);
  const xfdfInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [saved, setSaved] = useState<string | undefined>();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [askProtect, setAskProtect] = useState(false);
  /** The document's links, read with it, and one waiting to be opened. */
  const [pageLinks, setPageLinks] = useState<Link[]>([]);
  const [following, setFollowing] = useState<string | null>(null);

  /** Whether this machine can turn an Office document into a PDF. */
  const [office, setOffice] = useState(false);

  /** The signature panel, shown only when the document carries signatures. */
  const [showingSignatures, setShowingSignatures] = useState(false);

  /** What a redaction box should say, if anything — the code a law requires. */
  const [redactionCode, setRedactionCode] = useState("");

  /** The drawing's scale, which turns points into something useful on site. */
  const [scaleUnit, setScaleUnit] = useState<keyof typeof SCALES>("cm");
  const [scalePerUnit, setScalePerUnit] = useState(1);

  /** A link box drawn but not yet told where to go. */
  const [pendingLink, setPendingLink] = useState<{
    page: number;
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [linkKind, setLinkKind] = useState<"page" | "url">("page");

  /** Building a form: what kind of field the next drag makes, and its name. */
  const [fieldKind, setFieldKind] = useState<"text" | "checkbox" | "dropdown">("text");
  const [fieldChoices, setFieldChoices] = useState("");
  const [pendingField, setPendingField] = useState<{
    page: number;
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  /** Watermark, and the page labels the viewer's page box shows. */
  const [marking, setMarking] = useState(false);
  const [markText, setMarkText] = useState("DRAFT");
  const [markOpacity, setMarkOpacity] = useState(25);
  const [markRotation, setMarkRotation] = useState(45);
  const [markBehind, setMarkBehind] = useState(true);
  const [labelling, setLabelling] = useState(false);
  const [labelRanges, setLabelRanges] = useState<PageLabelRange[]>([
    { from: 0, style: "r" },
    { from: 2, style: "D", start: 1 },
  ]);

  /** Accessibility: what is wrong, and what the fix should say. */
  const [checking, setChecking] = useState(false);
  const [issues, setIssues] = useState<AccessibilityIssue[] | undefined>();
  const [docLanguage, setDocLanguage] = useState("en");

  /** Remove hidden information: what was found, and what to take out. */
  const [cleaning, setCleaning] = useState(false);
  const [hidden, setHidden] = useState<SanitiseReport | undefined>();
  const [cleanComments, setCleanComments] = useState(false);
  const [cleanLinks, setCleanLinks] = useState(false);

  /** Find-and-redact: what to look for, and what was found but not yet removed. */
  const [hunting, setHunting] = useState(false);
  const [patterns, setPatterns] = useState<PatternName[]>(["aadhaar"]);
  const [huntWords, setHuntWords] = useState("");
  const [foundToRedact, setFoundToRedact] = useState<Found | undefined>();

  /** What a stamp says. Acrobat's own list, plus the one a registry uses. */
  const [stampLabel, setStampLabel] = useState("Approved");
  /**
   * The signature drawn once and kept for the next document. It lives in this
   * browser only — localStorage, never the network — and holds strokes in 0-1 of
   * its box, so the same signature fits wherever it is placed.
   */
  const [signature, setSignature] = useState<{ x: number; y: number }[][] | null>(() =>
    loadSignature(),
  );
  const [drawingSignature, setDrawingSignature] = useState(false);

  /** File ▸ Properties: what the document says about itself. */
  const [describing, setDescribing] = useState(false);

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
  /** Edit-picture mode, which is the other half of editing a page. */
  const [editingImages, setEditingImages] = useState(false);
  const [imagesByPage, setImagesByPage] = useState<Map<number, PageImage[]>>(new Map());
  const [editRuns, setEditRuns] = useState<Map<number, EditableText[]>>(new Map());
  /** Extracted text per page, for the selectable layer over the canvas. */
  const [textRuns, setTextRuns] = useState<Map<number, TextRun[]>>(new Map());
  const [sidebar, setSidebar] = useState<
    "pages" | "outline" | "form" | "comments" | "attachments" | "layers"
  >("pages");
  /** Files carried inside the document, read when the panel is opened. */
  const [attached, setAttached] = useState<Attachment[]>([]);
  /** What a comparison found, and the name of what it was compared with. */
  const [diff, setDiff] = useState<{ against: string; diff: DocumentDiff } | undefined>();
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
  /** The page the reader is looking at, as a display position. */
  const [firstVisible, setFirstVisible] = useState(0);
  /** Two pages side by side, as a book opens. */
  const [facing, setFacing] = useState(false);

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
    setTextRuns(new Map());
    setImagesByPage(new Map());
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
    await openImages(await pickFiles(true, "image"));
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
  /** Writes the boxes drawn here into the document as marks, removing nothing. */
  const handleMarkRedactions = useCallback(async () => {
    const marks = [...redactions.entries()].flatMap(([page, rects]) =>
      rects.map((rect) => ({
        page,
        ...rect,
        ...(redactionCode.trim() ? { overlayText: redactionCode.trim() } : {}),
      })),
    );
    if (marks.length === 0) return;
    const done = await markRedactions(marks);
    if (!done) return;
    setRedactions(new Map());
    setSaved(
      `Marked ${marks.length} area${marks.length === 1 ? "" : "s"} — nothing is removed until you apply them`,
    );
  }, [markRedactions, redactionCode, redactions]);

  /** Applies the marks waiting in the document, and reports the verification. */
  const handleApplyRedactions = useCallback(async () => {
    const result = await applyRedactions();
    if (!result) return;
    const removed = Object.values(result.removed).reduce((n, c) => n + c, 0);
    setSaved(
      result.verified
        ? `Removed ${removed} object${removed === 1 ? "" : "s"}; no text left in the redacted areas`
        : `WARNING: text is still present after redacting (${result.leftovers.length} run${
            result.leftovers.length === 1 ? "" : "s"
          }). Do not share this file.`,
    );
  }, [applyRedactions]);

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

  /** Finds every match, and says how many, before anything is destroyed. */
  const handleFind = useCallback(async () => {
    const words = huntWords
      .split(",")
      .map((word) => word.trim())
      .filter((word) => word !== "");
    const found = await findPattern({ patterns, words });
    if (!found) return;
    setFoundToRedact(found);
    setSaved(
      found.count === 0
        ? "Nothing matched"
        : `${found.count} match${found.count === 1 ? "" : "es"} on ${found.areas.length} ` +
            `page${found.areas.length === 1 ? "" : "s"}` +
            (found.samples.length > 0 ? `, such as ${found.samples.slice(0, 3).join(", ")}` : ""),
    );
  }, [findPattern, huntWords, patterns]);

  /** Removes what the search found, through the same verified redaction pass. */
  const handleRedactFound = useCallback(async () => {
    if (!foundToRedact || foundToRedact.count === 0) return;
    const result = await redact(foundToRedact.areas);
    setFoundToRedact(undefined);
    if (!result) return;
    setHunting(false);
    const removed = Object.values(result.removed).reduce((n, c) => n + c, 0);
    setSaved(
      result.verified
        ? `Removed ${removed} object${removed === 1 ? "" : "s"}; no text left in the redacted areas`
        : `WARNING: text is still present after redacting (${result.leftovers.length} run${
            result.leftovers.length === 1 ? "" : "s"
          }). Do not share this file.`,
    );
  }, [foundToRedact, redact]);

  /**
   * Bookmark edits write the whole tree back, which is also what makes them
   * undoable: it is one document change, like any other.
   */
  const editBookmarks = useCallback(
    async (next: OutlineItem[]) => {
      const written = await setBookmarks(
        next.map(function strip(item): Bookmark {
          return {
            title: item.title,
            page: item.page,
            children: item.children.map(strip),
          };
        }),
      );
      if (written) setSaved("Bookmarks saved");
    },
    [setBookmarks],
  );

  const handleCheckAccessible = useCallback(async () => {
    setChecking(true);
    setIssues(undefined);
    const found = await checkAccessible();
    setIssues(found);
    if (found?.length === 0) setSaved("Nothing to fix: this document reads well");
  }, [checkAccessible]);

  const handleFixAccessible = useCallback(async () => {
    const done = await fixAccessible(stripPdf(name0), docLanguage);
    if (!done) return;
    const found = await checkAccessible();
    setIssues(found);
    setSaved("Title, language and window title set");
  }, [checkAccessible, docLanguage, fixAccessible, name0]);

  /** Opens the panel with a report of what is actually in this document. */
  const handleInspect = useCallback(async () => {
    setCleaning(true);
    const report = await findHidden();
    setHidden(report);
    if (report) {
      const clean =
        !report.metadata && report.attachments === 0 && report.scripts === 0 && report.links === 0;
      setSaved(clean ? "Nothing hidden found" : undefined);
    }
  }, [findHidden]);

  const handleSanitise = useCallback(async () => {
    const result = await sanitise({
      metadata: true,
      attachments: true,
      scripts: true,
      comments: cleanComments,
      links: cleanLinks,
    });
    if (!result) return;
    setCleaning(false);
    setHidden(undefined);
    const { removed } = result;
    const went = [
      removed.metadata ? "the description" : "",
      removed.attachments > 0 ? `${removed.attachments} attached file(s)` : "",
      removed.scripts > 0 ? `${removed.scripts} script(s)` : "",
      removed.comments > 0 ? `${removed.comments} comment(s)` : "",
      removed.links > 0 ? `${removed.links} link(s)` : "",
    ].filter((part) => part !== "");
    setSaved(went.length === 0 ? "Nothing hidden to remove" : `Removed ${went.join(", ")}`);
  }, [cleanComments, cleanLinks, sanitise]);

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

  /** Saves the document's words as a plain text file. */
  const handleSaveText = useCallback(async () => {
    const text = await extractAllText();
    if (text === undefined) return;
    const written = await saveBytes(
      new TextEncoder().encode(text).buffer as ArrayBuffer,
      `${stripPdf(name0)}.txt`,
      undefined,
      "text/plain",
    );
    setSaved(written ? `Saved ${written}` : undefined);
  }, [extractAllText, name0]);

  /** Prints what is on screen, marks and all, not the file as it was opened. */
  const handlePrint = useCallback(async () => {
    const bytes = await save(state.order);
    if (!bytes) return;
    setSaved(await printBytes(bytes, name0));
  }, [name0, save, state.order]);

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
      if (event.key.toLowerCase() === "d") {
        event.preventDefault();
        setDescribing((open) => !open);
        return;
      }
      if (event.key.toLowerCase() === "p") {
        // The browser's own print would print the app's chrome, not the
        // document, so this takes the key.
        event.preventDefault();
        void handlePrint();
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
  }, [
    handleDelete,
    handleOpen,
    handlePrint,
    handleSave,
    pageCount,
    positions.length,
    redo,
    stepZoom,
    undo,
  ]);

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
        if (tool === "link") {
          setPendingLink({ page, ...shape.rect });
          return;
        }
        if (tool === "field") {
          setPendingField({ page, ...shape.rect });
          return;
        }
        if (tool === "crop") {
          // The selection, or every page: cropping one page of a scan is rarely
          // what anyone wants.
          void crop(shape.rect, positions.length > 0 ? positions : undefined).then((done) => {
            if (done) {
              setTool(undefined);
              setSaved(
                positions.length > 0
                  ? `Cropped ${positions.length} page${positions.length === 1 ? "" : "s"}`
                  : "Cropped every page",
              );
            }
          });
          return;
        }
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
      if (shape.kind === "vector") {
        if (tool === "measure") {
          // A measurement is a line that says how long it is, which is what
          // makes it a measurement rather than a line.
          const scale = {
            pointsPerUnit: SCALES[scaleUnit]!.pointsPerUnit * scalePerUnit,
            unit: SCALES[scaleUnit]!.unit,
          };
          const length = distanceOf(
            { x: shape.x1, y: shape.y1 },
            { x: shape.x2, y: shape.y2 },
            scale,
          );
          addAnnotation({
            kind: "line",
            page,
            x1: shape.x1,
            y1: shape.y1,
            x2: shape.x2,
            y2: shape.y2,
            arrow: "both",
            color: colour,
            measurement: formatMeasurement(length, scale.unit),
          });
          return;
        }
        addAnnotation({
          kind: "line",
          page,
          x1: shape.x1,
          y1: shape.y1,
          x2: shape.x2,
          y2: shape.y2,
          color: colour,
          ...(tool === "arrow" ? { arrow: "end" as const } : {}),
        });
        return;
      }
      if (shape.kind === "path") {
        if (tool === "measurearea") {
          const scale = {
            pointsPerUnit: SCALES[scaleUnit]!.pointsPerUnit * scalePerUnit,
            unit: SCALES[scaleUnit]!.unit,
          };
          const size = areaOf(shape.points, scale);
          const round = perimeter(shape.points, scale, true);
          addAnnotation({
            kind: "polygon",
            page,
            points: shape.points,
            color: colour,
            measurement:
              `${formatMeasurement(size, scale.unit, true)} · ` +
              `${formatMeasurement(round, scale.unit)} round`,
          });
          return;
        }
        addAnnotation(
          tool === "polyline"
            ? { kind: "polyline", page, points: shape.points, color: colour }
            : {
                kind: "polygon",
                page,
                points: shape.points,
                color: colour,
                ...(tool === "cloud" ? { cloud: true } : {}),
              },
        );
        return;
      }
      if (tool === "callout" || tool === "caret") {
        // Both need words before they are worth creating, like a note.
        setPendingPoint({ page, x: shape.x, y: shape.y });
        return;
      }
      if (tool === "stamp") {
        // Sized like a rubber stamp, with the click at its top-left corner.
        addAnnotation({
          kind: "stamp",
          page,
          x: shape.x,
          y: shape.y - 36,
          w: Math.max(120, stampLabel.length * 14),
          h: 36,
          label: stampLabel,
          color: colour,
        });
        return;
      }
      if (tool === "signature") {
        if (!signature) {
          setDrawingSignature(true);
          return;
        }
        addAnnotation({
          kind: "signature",
          page,
          x: shape.x,
          y: shape.y - 36,
          w: 160,
          h: 48,
          strokes: signature,
        });
        return;
      }
      // A note or a text box needs its words before it is worth creating.
      setPendingPoint({ page, x: shape.x, y: shape.y });
    },
    [
      addAnnotation,
      colour,
      crop,
      placeMarkup,
      positions,
      scalePerUnit,
      scaleUnit,
      signature,
      stampLabel,
      tool,
    ],
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
      if (tool === "caret") {
        addAnnotation({
          kind: "caret",
          page: point.page,
          x: point.x,
          y: point.y,
          contents,
          color: colour,
        });
        return;
      }
      if (tool === "callout") {
        // The box sits up and to the right of what it points at, which is
        // where a reader expects a callout to be.
        addAnnotation({
          kind: "callout",
          page: point.page,
          x: point.x + 60,
          y: point.y + 40,
          w: 170,
          h: Math.max(32, 16 * Math.ceil(contents.length / 28)),
          contents,
          tipX: point.x,
          tipY: point.y,
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

  /** Reads a page's text once, when it first comes into view, so it can be
   *  selected and copied. */
  const needText = useCallback(
    (page: number) => {
      setTextRuns((current) => {
        if (current.has(page)) return current;
        const next = new Map(current);
        next.set(page, []);
        void pageText(page).then((runs) => setTextRuns((later) => new Map(later).set(page, runs)));
        return next;
      });
    },
    [pageText],
  );

  // Whether LibreOffice is on this machine, asked once (ADR 0007).
  useEffect(() => {
    void canConvertOffice().then(setOffice);
  }, []);

  const handleOffice = useCallback(async () => {
    const picked = await pickFiles(false, "office");
    const file = picked[0];
    if (!file) return;
    try {
      const bytes = await convertOffice(file);
      await open({ name: `${stripPdf(file.name)}.pdf`, type: "application/pdf", bytes });
      setSaved(`Converted ${file.name}`);
    } catch (error) {
      setSaved(error instanceof Error ? error.message : String(error));
    }
  }, [open]);

  // The document's links, re-read whenever it changes.
  useEffect(() => {
    if (!info) {
      setPageLinks([]);
      return;
    }
    void links().then(setPageLinks);
  }, [info, links]);

  // The files carried inside the document, re-read whenever it changes.
  useEffect(() => {
    if (!info) {
      setAttached([]);
      return;
    }
    void attachments().then(setAttached);
  }, [attachments, info]);

  /** Writes the marks out as XFDF, which is how a review travels without a server. */
  const handleExportMarks = useCallback(async () => {
    const xml = await exportMarks(name0);
    if (xml === undefined) return;
    const written = await saveBytes(
      new TextEncoder().encode(xml).buffer as ArrayBuffer,
      `${stripPdf(name0)}.xfdf`,
      undefined,
      "application/vnd.adobe.xfdf",
    );
    setSaved(written ? `Saved ${written}` : undefined);
  }, [exportMarks, name0]);

  const onXfdfInput = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      const [file] = await readFiles(files);
      if (!file) return;
      const result = await importMarks(new TextDecoder().decode(file.bytes));
      if (!result) return;
      const lost = result.dropped + result.skipped;
      setSaved(
        `Added ${result.added} mark${result.added === 1 ? "" : "s"}` +
          (lost > 0 ? `; ${lost} could not be placed and were left out` : ""),
      );
    },
    [importMarks],
  );

  /** Compares the open document with another file the user picks. */
  const handleCompare = useCallback(async () => {
    if (!canUsePicker()) {
      compareInput.current?.click();
      return;
    }
    const picked = await pickFiles(false);
    if (!picked[0]) return;
    const found = await compare(picked[0].bytes);
    if (found) setDiff({ against: picked[0].name, diff: found });
  }, [compare]);

  const onCompareInput = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      const [file] = await readFiles(files);
      if (!file) return;
      const found = await compare(file.bytes);
      if (found) setDiff({ against: file.name, diff: found });
    },
    [compare],
  );

  const attachOne = useCallback(
    async (file: { name: string; bytes: ArrayBuffer; type?: string | undefined }) => {
      const done = await attach(file);
      if (done) setSaved(`Attached ${file.name}`);
    },
    [attach],
  );

  const handleAttach = useCallback(async () => {
    if (!canUsePicker()) {
      attachInput.current?.click();
      return;
    }
    const picked = await pickFiles(false, "any");
    if (picked[0]) await attachOne(picked[0]);
  }, [attachOne]);

  const onAttachInput = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      const [file] = await readFiles(files);
      if (file) await attachOne(file);
    },
    [attachOne],
  );

  const handleSaveAttachment = useCallback(
    async (name: string) => {
      const bytes = await readAttachment(name);
      if (!bytes) return;
      const written = await saveBytes(bytes, name, undefined, "application/octet-stream");
      setSaved(written ? `Saved ${written}` : undefined);
    },
    [readAttachment],
  );

  /** Reads a page's pictures once, when it first comes into view. */
  const needImages = useCallback(
    (page: number) => {
      setImagesByPage((current) => {
        if (current.has(page)) return current;
        const next = new Map(current);
        next.set(page, []);
        void pageImages(page).then((found) =>
          setImagesByPage((later) => new Map(later).set(page, found)),
        );
        return next;
      });
    },
    [pageImages],
  );

  const handlePlaceImage = useCallback(
    async (page: number, index: number, box: { x: number; y: number; w: number; h: number }) => {
      const result = await editImages([{ page, index, action: "place", ...box }]);
      if (!result) return;
      setImagesByPage(new Map());
      setSaved(result.rejected[0]?.reason ?? "Picture moved");
    },
    [editImages],
  );

  const handleRemoveImage = useCallback(
    async (page: number, index: number) => {
      const result = await editImages([{ page, index, action: "remove" }]);
      if (!result) return;
      setImagesByPage(new Map());
      setSaved(result.rejected[0]?.reason ?? "Picture removed");
    },
    [editImages],
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
          {info
            ? action("Print", () => void handlePrint(), {
                testId: "print",
                hint: "Print the document as it is now (⌘P)",
              })
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
      <input
        ref={attachInput}
        type="file"
        data-testid="attach-input"
        className="visually-hidden"
        onChange={(event) => void onAttachInput(event.target.files)}
      />
      <input
        ref={compareInput}
        type="file"
        accept="application/pdf,.pdf"
        data-testid="compare-input"
        className="visually-hidden"
        onChange={(event) => void onCompareInput(event.target.files)}
      />
      <input
        ref={xfdfInput}
        type="file"
        accept=".xfdf,application/vnd.adobe.xfdf,text/xml"
        data-testid="xfdf-input"
        className="visually-hidden"
        onChange={(event) => void onXfdfInput(event.target.files)}
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
            const form = new FormData(event.currentTarget);
            const field = form.get("newPassword");
            if (typeof field === "string" && field !== "") {
              void protect(field, {
                print: form.get("allowPrint") ? "full" : "none",
                extract: form.get("allowCopy") !== null,
                modify: form.get("allowChanges") ? "all" : "none",
              });
              setAskProtect(false);
            }
          }}
        >
          <label htmlFor="newPassword">
            Password for the saved file. Keep it safe — a protected PDF cannot be opened without it.
            What is allowed below is a request to the reader, which most honour; the file is
            decrypted in their hands either way.
          </label>
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            autoFocus
            data-testid="new-password"
          />
          <span className="hfrow">
            <label className="hfcheck">
              <input type="checkbox" name="allowPrint" defaultChecked data-testid="allow-print" />
              Allow printing
            </label>
            <label className="hfcheck">
              <input type="checkbox" name="allowCopy" defaultChecked data-testid="allow-copy" />
              Allow copying text
            </label>
            <label className="hfcheck">
              <input type="checkbox" name="allowChanges" data-testid="allow-changes" />
              Allow changes
            </label>
          </span>
          <button type="submit" className="action action-go">
            Set password
          </button>
          <button type="button" className="action" onClick={() => setAskProtect(false)}>
            Cancel
          </button>
        </form>
      ) : null}

      {drawingSignature ? (
        <div className="prompt">
          <SignaturePad
            onCancel={() => setDrawingSignature(false)}
            onSave={(strokes) => {
              setSignature(strokes);
              saveSignature(strokes);
              setDrawingSignature(false);
              setTool("signature");
              setSaved("Signature saved on this device — click a page to place it");
            }}
          />
        </div>
      ) : null}

      {describing && info ? (
        <form
          className="prompt hfpanel"
          data-testid="properties-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const text = (name: string) => String(form.get(name) ?? "");
            void describe({
              title: text("title"),
              author: text("author"),
              subject: text("subject"),
              keywords: text("keywords"),
            }).then((done) => {
              if (done) {
                setDescribing(false);
                setSaved("Description saved");
              }
            });
          }}
        >
          <div className="hfrow">
            <span className="hflabel">Title</span>
            <input
              className="hfslot"
              name="title"
              data-testid="prop-title"
              defaultValue={info.properties.title}
              placeholder="What this document is called"
            />
            <span className="hflabel">Author</span>
            <input
              className="hfslot"
              name="author"
              data-testid="prop-author"
              defaultValue={info.properties.author}
              placeholder="Who wrote it"
            />
          </div>
          <div className="hfrow">
            <span className="hflabel">Subject</span>
            <input
              className="hfslot"
              name="subject"
              data-testid="prop-subject"
              defaultValue={info.properties.subject}
            />
            <span className="hflabel">Keywords</span>
            <input
              className="hfslot"
              name="keywords"
              data-testid="prop-keywords"
              defaultValue={info.properties.keywords}
              placeholder="Separated by commas"
            />
          </div>
          <div className="hfrow">
            <span className="hfnote">
              What a catalogue, a search index and a file browser read.
              {info.properties.producer ? ` Made by ${info.properties.producer}.` : ""}
            </span>
            <button type="submit" className="action action-go" data-testid="apply-properties">
              Save description
            </button>
            <button type="button" className="action" onClick={() => setDescribing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {diff ? (
        <div className="prompt hfpanel" data-testid="diff-panel">
          <div className="hfrow">
            <span className="hflabel">Changes</span>
            <span className="hfnote" data-testid="diff-summary">
              {diff.diff.changed === 0 &&
              diff.diff.onlyHere.length === 0 &&
              diff.diff.onlyThere.length === 0
                ? `Nothing differs from ${diff.against}.`
                : `${diff.diff.changed} page${diff.diff.changed === 1 ? "" : "s"} differ from ${
                    diff.against
                  }` +
                  (diff.diff.onlyHere.length > 0
                    ? `, and ${diff.diff.onlyHere.length} page${
                        diff.diff.onlyHere.length === 1 ? " is" : "s are"
                      } only here`
                    : "") +
                  (diff.diff.onlyThere.length > 0
                    ? `, and ${diff.diff.onlyThere.length} page${
                        diff.diff.onlyThere.length === 1 ? " is" : "s are"
                      } only in that one`
                    : "") +
                  ". Pages are paired by position, not matched up."}
            </span>
            <button type="button" className="action" onClick={() => setDiff(undefined)}>
              Close
            </button>
          </div>
          <ul className="difflist" data-testid="diff-list">
            {diff.diff.pages
              .filter((page) => !page.same)
              .map((page) => (
                <li key={page.page} data-testid={`diff-page-${page.page}`}>
                  <button type="button" className="diff-page" onClick={() => setGoTo(page.page)}>
                    Page {page.page + 1}
                  </button>
                  {page.removed.map((text, index) => (
                    <span key={`-${index}`} className="diff-removed">
                      {text}
                    </span>
                  ))}
                  {page.added.map((text, index) => (
                    <span key={`+${index}`} className="diff-added">
                      {text}
                    </span>
                  ))}
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      {following ? (
        <div className="prompt" data-testid="follow-prompt">
          <span className="hfnote">
            This link goes to <strong data-testid="follow-url">{following}</strong>, which is
            outside this document and outside this app.
          </span>
          <a
            className="action action-go"
            href={following}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="follow-open"
            onClick={() => setFollowing(null)}
          >
            Open it in the browser
          </a>
          <button type="button" className="action" onClick={() => setFollowing(null)}>
            Cancel
          </button>
        </div>
      ) : null}

      {pendingLink && info ? (
        <form
          className="prompt"
          data-testid="link-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const target =
              linkKind === "url"
                ? { url: String(form.get("linkUrl") ?? "").trim() }
                : { page: Math.max(0, Number(form.get("linkPage") ?? 1) - 1) };
            void addPageLink({ ...pendingLink, target })
              .then((done) => {
                setPendingLink(null);
                if (done) setSaved("Link added");
              })
              .catch(() => setPendingLink(null));
          }}
        >
          <label htmlFor="linkPage">Where should this box take the reader?</label>
          <select
            aria-label="Kind of link"
            data-testid="link-kind"
            value={linkKind}
            onChange={(event) => setLinkKind(event.target.value as "page" | "url")}
          >
            <option value="page">A page of this document</option>
            <option value="url">A web address</option>
          </select>
          {linkKind === "page" ? (
            <input
              id="linkPage"
              name="linkPage"
              type="number"
              min={1}
              max={pageCount}
              defaultValue={Math.min(firstVisible + 2, pageCount)}
              data-testid="link-page"
            />
          ) : (
            <input
              name="linkUrl"
              type="url"
              placeholder="https://…"
              data-testid="link-url"
              autoFocus
            />
          )}
          <button type="submit" className="action action-go" data-testid="add-link">
            Add the link
          </button>
          <button type="button" className="action" onClick={() => setPendingLink(null)}>
            Cancel
          </button>
        </form>
      ) : null}

      {pendingField && info ? (
        <form
          className="prompt"
          data-testid="field-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get("fieldName") ?? "").trim();
            if (name === "") return;
            const choices = fieldChoices
              .split(",")
              .map((choice) => choice.trim())
              .filter((choice) => choice !== "");
            void addFormField({
              ...pendingField,
              name,
              kind: fieldKind,
              ...(fieldKind === "dropdown" ? { options: choices } : {}),
            }).then((done) => {
              setPendingField(null);
              if (done) setSaved(`Added the field ${name}`);
            });
          }}
        >
          <label htmlFor="fieldName">
            What is this field called? The name is how its value is read back — applicant.name
            rather than Field1.
          </label>
          <input id="fieldName" name="fieldName" autoFocus data-testid="field-name" />
          <select
            aria-label="Kind of field"
            data-testid="field-kind"
            value={fieldKind}
            onChange={(event) => setFieldKind(event.target.value as typeof fieldKind)}
          >
            <option value="text">Text</option>
            <option value="checkbox">Tick box</option>
            <option value="dropdown">Choose one</option>
          </select>
          {fieldKind === "dropdown" ? (
            <input
              aria-label="Choices, separated by commas"
              placeholder="Choices, separated by commas"
              data-testid="field-choices"
              value={fieldChoices}
              onChange={(event) => setFieldChoices(event.target.value)}
            />
          ) : null}
          <button type="submit" className="action action-go" data-testid="add-field">
            Add the field
          </button>
          <button type="button" className="action" onClick={() => setPendingField(null)}>
            Cancel
          </button>
        </form>
      ) : null}

      {marking && info ? (
        <form
          className="prompt hfpanel"
          data-testid="watermark-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void addWatermark({
              text: markText,
              opacity: markOpacity / 100,
              rotation: markRotation,
              placement: markBehind ? "behind" : "front",
              ...(positions.length > 0 ? { pages: positions } : {}),
            }).then((done) => {
              if (done) {
                setMarking(false);
                setSaved("Watermark added");
              }
            });
          }}
        >
          <div className="hfrow">
            <span className="hflabel">Says</span>
            <input
              className="hfslot"
              data-testid="watermark-text"
              value={markText}
              onChange={(event) => setMarkText(event.target.value)}
            />
            <label className="hfcheck">
              <input
                type="checkbox"
                data-testid="watermark-behind"
                checked={markBehind}
                onChange={(event) => setMarkBehind(event.target.checked)}
              />
              Behind the text
            </label>
          </div>
          <div className="hfrow hfoptions">
            <label>
              Fade
              <input
                type="number"
                min={5}
                max={100}
                value={markOpacity}
                data-testid="watermark-opacity"
                onChange={(event) => setMarkOpacity(event.target.valueAsNumber || 25)}
              />
              %
            </label>
            <label>
              Angle
              <input
                type="number"
                min={-90}
                max={90}
                value={markRotation}
                onChange={(event) => setMarkRotation(event.target.valueAsNumber || 0)}
              />
              °
            </label>
            <span className="hfnote">
              {positions.length > 0
                ? `On the ${positions.length} selected page${positions.length === 1 ? "" : "s"}.`
                : "On every page."}{" "}
              Behind the text keeps the document readable; over it is harder to ignore.
            </span>
            <button type="submit" className="action action-go" data-testid="apply-watermark">
              Add
            </button>
            <button type="button" className="action" onClick={() => setMarking(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {labelling && info ? (
        <div className="prompt hfpanel" data-testid="labels-panel">
          <div className="hfrow">
            <span className="hflabel">Numbering</span>
            <span className="hfnote">
              What the page box shows, which is a different thing from numbers printed on the page.
              A report numbered i, ii, iii then 1, 2, 3 should answer "go to page 4" the way its own
              pages do.
            </span>
          </div>
          {labelRanges.map((range, index) => (
            <div className="hfrow hfoptions" key={index}>
              <label>
                From page
                <input
                  type="number"
                  min={1}
                  max={pageCount}
                  value={range.from + 1}
                  data-testid={`label-from-${index}`}
                  onChange={(event) =>
                    setLabelRanges((current) =>
                      current.map((one, i) =>
                        i === index
                          ? { ...one, from: Math.max(0, (event.target.valueAsNumber || 1) - 1) }
                          : one,
                      ),
                    )
                  }
                />
              </label>
              <label>
                as
                <select
                  value={range.style ?? "D"}
                  data-testid={`label-style-${index}`}
                  onChange={(event) =>
                    setLabelRanges((current) =>
                      current.map((one, i) =>
                        i === index
                          ? { ...one, style: event.target.value as PageLabelRange["style"] }
                          : one,
                      ),
                    )
                  }
                >
                  <option value="D">1, 2, 3</option>
                  <option value="r">i, ii, iii</option>
                  <option value="R">I, II, III</option>
                  <option value="a">a, b, c</option>
                  <option value="A">A, B, C</option>
                  <option value="none">prefix only</option>
                </select>
              </label>
              <label>
                prefix
                <input
                  type="text"
                  value={range.prefix ?? ""}
                  data-testid={`label-prefix-${index}`}
                  onChange={(event) =>
                    setLabelRanges((current) =>
                      current.map((one, i) =>
                        i === index ? { ...one, prefix: event.target.value } : one,
                      ),
                    )
                  }
                />
              </label>
              {labelRanges.length > 1 && index > 0 ? (
                <button
                  type="button"
                  className="action"
                  onClick={() => setLabelRanges((current) => current.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          <div className="hfrow">
            {action("Add a run", () =>
              setLabelRanges((current) => [
                ...current,
                {
                  from: Math.min(pageCount - 1, (current[current.length - 1]?.from ?? 0) + 1),
                  style: "D",
                },
              ]),
            )}
            {action(
              "Apply",
              () => {
                void setLabels(labelRanges).then((done) => {
                  if (done) {
                    setLabelling(false);
                    setSaved("Page numbering set");
                  }
                });
              },
              { testId: "apply-labels" },
            )}
            {action("Remove numbering", () => {
              void setLabels([]).then((done) => {
                if (done) {
                  setLabelling(false);
                  setSaved("Page numbering removed");
                }
              });
            })}
            <button type="button" className="action" onClick={() => setLabelling(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {showingSignatures && info ? (
        <div className="prompt hfpanel" data-testid="signature-panel">
          <div className="hfrow">
            <span className="hflabel">Signed</span>
            <span className="hfnote">
              What the document says about itself. The certificate chain has not been checked — this
              says who it claims signed it and what the signature covers, not that the cryptography
              is sound.
            </span>
            <button type="button" className="action" onClick={() => setShowingSignatures(false)}>
              Close
            </button>
          </div>
          <ul className="a11ylist" data-testid="signature-list">
            {info.signatures.map((signature) => (
              <li
                key={signature.field}
                className={signature.coversWholeFile ? "a11y-ok" : "a11y-fail"}
                data-testid={`signature-${signature.field}`}
              >
                <strong>{signature.signer || "(no name given)"}</strong>
                <span>
                  {signature.date ? `${signature.date}. ` : ""}
                  {signature.reason ? `${signature.reason}. ` : ""}
                  {signature.coversWholeFile
                    ? "Covers the whole file."
                    : `${signature.bytesAppended} bytes were added after this was signed.`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {checking && info ? (
        <div className="prompt hfpanel" data-testid="accessibility-panel">
          <div className="hfrow">
            <span className="hflabel">Reading</span>
            <span className="hfnote">
              Whether someone using a screen reader could read this document.
            </span>
            <label className="hfcheck">
              Language
              <select
                aria-label="Document language"
                data-testid="doc-language"
                value={docLanguage}
                onChange={(event) => setDocLanguage(event.target.value)}
              >
                <option value="en">English</option>
                <option value="en-IN">English (India)</option>
                <option value="ml">Malayalam</option>
                <option value="hi">Hindi</option>
                <option value="ta">Tamil</option>
              </select>
            </label>
          </div>
          <ul className="a11ylist" data-testid="accessibility-issues">
            {issues === undefined ? (
              <li>Checking…</li>
            ) : issues.length === 0 ? (
              <li className="a11y-ok">Nothing to fix.</li>
            ) : (
              issues.map((issue) => (
                <li key={issue.id} className={`a11y-${issue.severity}`}>
                  <strong>{issue.summary}</strong>
                  <span>{issue.detail}</span>
                  {issue.fixable ? <em>Can be fixed here</em> : <em>Needs more than a setting</em>}
                </li>
              ))
            )}
          </ul>
          <div className="hfrow">
            {action("Set title and language", () => void handleFixAccessible(), {
              testId: "fix-accessibility",
              hint: "Names the document and says what language it is in",
            })}
            <button type="button" className="action" onClick={() => setChecking(false)}>
              Close
            </button>
          </div>
        </div>
      ) : null}

      {cleaning && info ? (
        <div className="prompt hfpanel" data-testid="sanitise-panel">
          <div className="hfrow">
            <span className="hflabel">Hidden</span>
            <span className="hfnote" data-testid="hidden-report">
              {hidden
                ? [
                    hidden.metadata ? "a description" : "",
                    hidden.attachments > 0 ? `${hidden.attachments} attached file(s)` : "",
                    hidden.scripts > 0 ? `${hidden.scripts} script(s) or action(s)` : "",
                    hidden.comments > 0 ? `${hidden.comments} comment(s)` : "",
                    hidden.links > 0 ? `${hidden.links} link(s)` : "",
                  ]
                    .filter((part) => part !== "")
                    .join(", ") || "nothing hidden"
                : "Looking…"}
            </span>
          </div>
          <div className="hfrow">
            <span className="hflabel">Also</span>
            <label className="hfcheck">
              <input
                type="checkbox"
                data-testid="clean-comments"
                checked={cleanComments}
                onChange={(event) => setCleanComments(event.target.checked)}
              />
              Remove comments and marks
            </label>
            <label className="hfcheck">
              <input
                type="checkbox"
                data-testid="clean-links"
                checked={cleanLinks}
                onChange={(event) => setCleanLinks(event.target.checked)}
              />
              Remove links
            </label>
          </div>
          <div className="hfrow">
            <span className="hfnote">
              The description, attached files, scripts and actions always go. None of this is
              visible on any page, and all of it travels with the file.
            </span>
            {action("Remove it", () => void handleSanitise(), {
              testId: "apply-sanitise",
              danger: true,
            })}
            <button
              type="button"
              className="action"
              onClick={() => {
                setCleaning(false);
                setHidden(undefined);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {hunting && info ? (
        <form
          className="prompt hfpanel"
          data-testid="find-redact-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void handleFind();
          }}
        >
          <div className="hfrow">
            <span className="hflabel">Find</span>
            {PATTERN_CHOICES.map(({ name, label }) => (
              <label key={name} className="hfcheck">
                <input
                  type="checkbox"
                  data-testid={`pattern-${name}`}
                  checked={patterns.includes(name)}
                  onChange={(event) => {
                    setFoundToRedact(undefined);
                    setPatterns((current) =>
                      event.target.checked
                        ? [...current, name]
                        : current.filter((one) => one !== name),
                    );
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          <div className="hfrow">
            <span className="hflabel">Words</span>
            <input
              className="hfslot"
              data-testid="hunt-words"
              value={huntWords}
              placeholder="Any words to remove as well, separated by commas"
              onChange={(event) => {
                setFoundToRedact(undefined);
                setHuntWords(event.target.value);
              }}
            />
          </div>
          <div className="hfrow">
            <span className="hfnote">
              Searches every page and shows what it found. Nothing is removed until you say so, and
              what is removed is taken out of the file, not covered over.
            </span>
            <button type="submit" className="action action-go" data-testid="find-matches">
              Search
            </button>
            {action(
              foundToRedact && foundToRedact.count > 0 ? `Remove ${foundToRedact.count}` : "Remove",
              () => void handleRedactFound(),
              {
                testId: "redact-matches",
                danger: true,
                off: disabled || !foundToRedact || foundToRedact.count === 0,
                hint: "Remove every match from the file, then check it is gone",
              },
            )}
            <button
              type="button"
              className="action"
              onClick={() => {
                setHunting(false);
                setFoundToRedact(undefined);
              }}
            >
              Cancel
            </button>
          </div>
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
                  ["attachments", "Files", attached.length],
                  ["layers", "Layers", info.layers.length],
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
                <div className="panel-actions">
                  {action("Send marks…", () => void handleExportMarks(), {
                    testId: "export-marks",
                    hint: "Writes the marks as an XFDF file to send to a reviewer",
                  })}
                  {action("Import marks…", () => xfdfInput.current?.click(), {
                    testId: "import-marks",
                    hint: "Reads marks a reviewer sent back",
                  })}
                </div>
                <CommentList
                  annotations={state.annotations}
                  existing={info.marks}
                  onRemoveExisting={(page, index) => {
                    void deleteMark(page, index).then((done) => done && setSaved("Mark removed"));
                  }}
                  onReply={(page, index, contents, state) => {
                    void replyToMark({
                      page,
                      index,
                      contents,
                      ...(state && state !== "None"
                        ? { state: state as "Accepted" | "Rejected" | "Cancelled" | "Completed" }
                        : {}),
                    }).then((done) => done && setSaved(state ? "Marked " + state : "Reply saved"));
                  }}
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
                <div className="panel-actions">
                  {action("Add a field", () => setTool("field"), {
                    testId: "add-field-tool",
                    hint: "Then drag on the page where someone should fill something in",
                  })}
                  {info.form.fields.length > 0
                    ? action("Write values", () => void handleForm(false), {
                        testId: "apply-form",
                        off: disabled || Object.keys(fieldValues).length === 0,
                      })
                    : null}
                  {info.form.fields.length > 0
                    ? action("Flatten", () => void handleForm(true), {
                        testId: "flatten-form",
                        hint: "Write the values in and remove the fields",
                      })
                    : null}
                </div>
                {info.form.fields.length > 0 ? (
                  <ul className="fieldlist" data-testid="field-list">
                    {info.form.fields.map((field) => (
                      <li key={field.name}>
                        <span className="fieldlist-name">{field.name}</span>
                        <span className="fieldlist-kind">{field.kind}</span>
                        <button
                          type="button"
                          aria-label={`Remove the field ${field.name}`}
                          data-testid={`remove-field-${field.name}`}
                          onClick={() => {
                            void removeFormField(field.name).then(
                              (done) => done && setSaved(`Removed the field ${field.name}`),
                            );
                          }}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : sidebar === "layers" ? (
              <div className="sidebar-scroll">
                {info.layers.length === 0 ? (
                  <p className="comments-empty" data-testid="layers-empty">
                    This document has no layers.
                  </p>
                ) : (
                  <>
                    <p className="tool-hint">
                      Turning a layer off hides it for a reader. The content stays in the file —
                      Remove hidden info is what takes it out.
                    </p>
                    <ul className="fieldlist" data-testid="layer-list">
                      {info.layers.map((layer) => (
                        <li key={layer.id}>
                          <label className="hfcheck">
                            <input
                              type="checkbox"
                              checked={layer.visible}
                              data-testid={`layer-${layer.name}`}
                              // The next state comes from the document, not from
                              // the box: the box is controlled by what the file
                              // says, and only changes once the worker has
                              // written it.
                              onChange={() => {
                                const wanted = !layer.visible;
                                void setLayers({ [layer.id]: wanted }).then(
                                  (done) =>
                                    done &&
                                    setSaved(`${layer.name} ${wanted ? "shown" : "hidden"}`),
                                );
                              }}
                            />
                            {layer.name}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ) : sidebar === "attachments" ? (
              <div className="sidebar-scroll">
                <div className="panel-actions">
                  {action("Attach a file…", () => void handleAttach(), {
                    testId: "attach-file",
                    hint: "Carries a file inside this PDF, wherever it goes",
                  })}
                </div>
                {attached.length === 0 ? (
                  <p className="comments-empty" data-testid="attachments-empty">
                    No files are carried inside this document. One attached here travels with it —
                    and is removed by Remove hidden info, which is the other half of the same thing.
                  </p>
                ) : (
                  <ul className="fieldlist" data-testid="attachment-list">
                    {attached.map((file) => (
                      <li key={file.name}>
                        <span className="fieldlist-name">{file.name}</span>
                        <span className="fieldlist-kind">{Math.ceil(file.size / 1024)} kB</span>
                        <button
                          type="button"
                          aria-label={`Extract ${file.name}`}
                          data-testid={`save-attachment-${file.name}`}
                          onClick={() => void handleSaveAttachment(file.name)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${file.name}`}
                          data-testid={`remove-attachment-${file.name}`}
                          onClick={() => {
                            void removeAttachment(file.name).then(
                              (done) => done && setSaved(`Removed ${file.name}`),
                            );
                          }}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : sidebar === "outline" ? (
              <div className="outline-panel">
                <div className="action-row">
                  {action(
                    "Add a bookmark here",
                    () => {
                      const page = state.order[Math.min(firstVisible, state.order.length - 1)] ?? 0;
                      void editBookmarks(
                        addBookmark(info.outline, `Page ${firstVisible + 1}`, page),
                      );
                    },
                    {
                      testId: "add-bookmark",
                      hint: "Adds a bookmark pointing at the page you are looking at",
                    },
                  )}
                </div>
                <Outline
                  items={info.outline}
                  onGo={(page) => {
                    const position = state.order.indexOf(page);
                    if (position >= 0) setGoTo(position);
                  }}
                  onRename={(path, title) =>
                    void editBookmarks(renameAt(info.outline, path, title))
                  }
                  onRemove={(path) => void editBookmarks(removeAt(info.outline, path))}
                  onMove={(path, by) => void editBookmarks(moveAt(info.outline, path, by))}
                />
              </div>
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
              text={textRuns}
              onNeedText={needText}
              onVisible={setFirstVisible}
              facing={facing}
              links={pageLinks}
              onFollow={(link) => {
                if (link.target.page !== undefined) {
                  const position = state.order.indexOf(link.target.page);
                  if (position >= 0) setGoTo(position);
                  return;
                }
                // A web address is never opened on the document's say-so: the
                // reader sees where it goes and decides.
                if (link.target.url) setFollowing(link.target.url);
              }}
              editingImages={editingImages}
              images={imagesByPage}
              onNeedImages={needImages}
              onPlaceImage={(page, index, box) => void handlePlaceImage(page, index, box)}
              onRemoveImage={(page, index) => void handleRemoveImage(page, index)}
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
                  setEditingImages(false);
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

              <button
                type="button"
                className={editingImages ? "edit-toggle edit-toggle-on" : "edit-toggle"}
                aria-pressed={editingImages}
                disabled={disabled}
                data-testid="edit-images"
                onClick={() => {
                  setEditingImages((on) => !on);
                  setEditingText(false);
                  setTool(undefined);
                  setImagesByPage(new Map());
                }}
              >
                <span className="tool-icon" aria-hidden="true">
                  ▨
                </span>
                <span>
                  <strong>Edit pictures</strong>
                  <small>Drag a picture to move it, its corner to resize it</small>
                </span>
              </button>
              {editingImages ? (
                <p className="tool-hint" data-testid="image-caveat">
                  Moves and resizes the picture where it sits, without touching the picture itself.
                  A rotated one straightens when it is moved.
                </p>
              ) : null}
            </section>

            <section className="tool-group">
              <h2>Annotate</h2>
              <div className="tool-grid">
                {(["highlight", "underline", "strike", "note", "text"] as const).map(toolButton)}
              </div>
              <div className="tool-grid">
                {(["square", "circle", "ink", "line", "arrow"] as const).map(toolButton)}
              </div>
              <div className="tool-grid">
                {(["polygon", "cloud", "polyline", "callout", "caret"] as const).map(toolButton)}
              </div>
              <div className="tool-grid">
                {(["measure", "measurearea"] as const).map(toolButton)}
              </div>
              {tool === "measure" || tool === "measurearea" ? (
                <div className="tool-options" data-testid="scale-options">
                  <span className="tool-options-label">Scale</span>
                  <span className="hfcheck">
                    1
                    <select
                      aria-label="Drawing unit"
                      data-testid="scale-unit"
                      value={scaleUnit}
                      onChange={(event) => setScaleUnit(event.target.value as keyof typeof SCALES)}
                    >
                      {Object.keys(SCALES).map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    =
                    <input
                      type="number"
                      min={0.001}
                      step={0.5}
                      value={scalePerUnit}
                      data-testid="scale-per-unit"
                      onChange={(event) => setScalePerUnit(event.target.valueAsNumber || 1)}
                    />
                    on the drawing
                  </span>
                </div>
              ) : null}
              <div className="tool-grid">{(["stamp", "signature"] as const).map(toolButton)}</div>
              {tool && ["polygon", "cloud", "polyline"].includes(tool) ? (
                <p className="tool-hint" data-testid="path-hint">
                  Click each corner; double-click to finish.
                </p>
              ) : null}
              {tool === "stamp" ? (
                <div className="tool-options">
                  <span className="tool-options-label">Says</span>
                  <select
                    aria-label="Stamp text"
                    data-testid="stamp-label"
                    value={stampLabel}
                    onChange={(event) => setStampLabel(event.target.value)}
                  >
                    {STAMPS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {tool === "signature" ? (
                <div className="tool-options">
                  <span className="tool-options-label">Signature</span>
                  {action(signature ? "Redraw…" : "Draw it…", () => setDrawingSignature(true), {
                    testId: "draw-signature",
                    hint: "Draw your signature once; it is kept on this device only",
                  })}
                  {signature ? (
                    <span className="tool-hint">Click a page to place it</span>
                  ) : (
                    <span className="tool-hint">Draw one first</span>
                  )}
                </div>
              ) : null}
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
              <div className="action-row">
                {info.signatures.length > 0
                  ? action(
                      `${info.signatures.length} signature${info.signatures.length === 1 ? "" : "s"}…`,
                      () => setShowingSignatures((open) => !open),
                      {
                        testId: "signatures",
                        hint: "Who signed this document, and what their signature covers",
                      },
                    )
                  : null}
                {action("Check accessibility…", () => void handleCheckAccessible(), {
                  testId: "check-accessibility",
                  hint: "Whether a screen reader could read this document",
                })}
                {action("Remove hidden info…", () => void handleInspect(), {
                  testId: "sanitise",
                  hint: "Metadata, attached files, scripts and actions — what travels unseen",
                })}
                {action("Redact by pattern…", () => setHunting((open) => !open), {
                  testId: "find-redact",
                  hint: "Find Aadhaar or PAN numbers, emails, phone numbers or words, and remove every one",
                })}
              </div>
              {tool === "redact" || redactionCount > 0 ? (
                <div className="tool-options">
                  <span className="tool-options-label">Says</span>
                  <input
                    className="hfslot"
                    placeholder="Code to print in the box, e.g. s.8(1)(j)"
                    data-testid="redaction-code"
                    value={redactionCode}
                    onChange={(event) => setRedactionCode(event.target.value)}
                  />
                </div>
              ) : null}
              {redactionCount > 0 ? (
                <div className="action-row">
                  {action(
                    `Mark ${redactionCount} area${redactionCount === 1 ? "" : "s"}`,
                    () => void handleMarkRedactions(),
                    {
                      testId: "mark-redaction",
                      hint: "Writes the marks into the document; nothing is removed yet",
                    },
                  )}
                  {action(
                    `Remove ${redactionCount} area${redactionCount === 1 ? "" : "s"} now`,
                    () => void handleRedact(),
                    {
                      testId: "apply-redaction",
                      danger: true,
                      hint: "Delete the marked content permanently, without marking it first",
                    },
                  )}
                </div>
              ) : null}
              {info.redactions.length > 0 ? (
                <div className="action-row" data-testid="pending-redactions">
                  <span className="tool-hint">
                    {info.redactions.length} area
                    {info.redactions.length === 1 ? " is" : "s are"} marked for removal in this
                    document.
                  </span>
                  {action("Apply the marks", () => void handleApplyRedactions(), {
                    testId: "apply-marks",
                    danger: true,
                    hint: "Removes the marked content and blacks out where it was",
                  })}
                </div>
              ) : null}
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
              <div className="tool-grid">
                {toolButton("crop")}
                {toolButton("link")}
              </div>
              {tool === "crop" ? (
                <p className="tool-hint" data-testid="crop-hint">
                  Drag the part of the page to keep. Cropping hides the rest; it does not remove it,
                  so redact anything that must be gone.
                </p>
              ) : null}
              {action(
                "Put the crop back",
                () => {
                  void crop(null).then((done) => done && setSaved("Crop removed"));
                },
                { testId: "uncrop" },
              )}
              <div className="action-row">
                {action("Watermark…", () => setMarking((open) => !open), {
                  testId: "watermark",
                  hint: "A word across the page, behind or over its text",
                })}
                {action("Page numbering…", () => setLabelling((open) => !open), {
                  testId: "page-labels",
                  hint: "What the viewer's page box shows: i, ii, iii then 1, 2, 3",
                })}
              </div>
              <div className="action-row">
                {action("Page numbers…", () => setNumbering((open) => !open), {
                  testId: "number-pages",
                  hint: "Headers, footers, page numbers and Bates numbering",
                })}
                {action("Properties…", () => setDescribing((open) => !open), {
                  testId: "properties",
                  hint: "Title, author, subject and keywords (⌘D)",
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
                {action("Compare with…", () => void handleCompare(), {
                  testId: "compare",
                  hint: "What changed between this document and another version of it",
                })}
                {action("To text…", () => void handleSaveText(), {
                  testId: "to-text",
                  hint: "Save the document's words as a plain text file",
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
              {office
                ? action("From Word or Excel…", () => void handleOffice(), {
                    testId: "from-office",
                    off: !ready,
                    hint: `Converts ${OFFICE_EXTENSIONS.slice(0, 3).join(", ")} and the rest with this machine's LibreOffice`,
                  })
                : null}
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
          <span className="pagebox" data-testid="page-box">
            Page {Math.min(firstVisible + 1, pageCount)} of {pageCount}
          </span>
        ) : null}
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
            <button
              type="button"
              className={facing ? "on" : undefined}
              aria-pressed={facing}
              data-testid="facing"
              onClick={() => setFacing((on) => !on)}
              disabled={disabled}
              title="Two pages side by side, as a book opens"
            >
              Two-up
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
  crop: "⌗",
  field: "▭̲",
  link: "⛓",
  line: "╱",
  arrow: "↗",
  polygon: "⬠",
  cloud: "☁",
  measure: "↔",
  measurearea: "▧",
  polyline: "〰",
  callout: "🗩",
  caret: "^",
  stamp: "▣",
  signature: "✒",
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
  crop: "Drag the part of the page to keep",
  field: "Drag where someone should fill something in",
  link: "Drag a box, then say where it should go",
  line: "Drag to draw a line",
  arrow: "Drag to draw an arrow, pointing where you finish",
  measure: "Drag along what you want the length of",
  measurearea: "Click each corner of an area, double-click to close it",
  polygon: "Click each corner, double-click to close the shape",
  cloud: "Click each corner, double-click to close it as a cloud",
  polyline: "Click each point, double-click to finish the path",
  callout: "Click what you want to point at, then type",
  caret: "Click where something is missing, then type what belongs there",
  stamp: "Click a page to stamp it",
  signature: "Click a page to sign it",
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
  crop: "Crop",
  field: "Add a field",
  link: "Link",
  line: "Line",
  arrow: "Arrow",
  polygon: "Shape",
  cloud: "Cloud",
  measure: "Distance",
  measurearea: "Area",
  polyline: "Path",
  callout: "Callout",
  caret: "Insert",
  stamp: "Stamp",
  signature: "Sign",
  redact: "Redact",
};

/** The patterns offered, named for what a clerk would call them. */
const PATTERN_CHOICES: { name: PatternName; label: string }[] = [
  { name: "aadhaar", label: "Aadhaar numbers" },
  { name: "pan", label: "PAN numbers" },
  { name: "phone", label: "Phone numbers" },
  { name: "email", label: "Email addresses" },
];

/** What a rubber stamp can say. Acrobat's own list, plus the registry's. */
const STAMPS = [
  "Approved",
  "Not approved",
  "Draft",
  "Final",
  "Confidential",
  "Received",
  "Reviewed",
  "For official use",
];

/**
 * The drawn signature, kept in this browser only — never sent anywhere, and not
 * part of any document until it is placed on one. Browser storage can be
 * unavailable, in which case the signature simply does not persist.
 */
const SIGNATURE_KEY = "pdf-suite.signature";

function loadSignature(): { x: number; y: number }[][] | null {
  try {
    const stored = localStorage.getItem(SIGNATURE_KEY);
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? (parsed as { x: number; y: number }[][]) : null;
  } catch {
    return null;
  }
}

function saveSignature(strokes: { x: number; y: number }[][]): void {
  try {
    localStorage.setItem(SIGNATURE_KEY, JSON.stringify(strokes));
  } catch {
    // A private window, or storage turned off. The signature still works for
    // this session; it just will not be there next time.
  }
}

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
