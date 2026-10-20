import { useEffect, useMemo } from "react";
import type { Annotation } from "@pdf-suite/core";
import { AnnotationLayer, type AnnotationTool, type PlacedShape } from "./AnnotationLayer.js";
import { TextEditLayer, type TextEditCommit } from "./TextEditLayer.js";
import { TextLayer } from "./TextLayer.js";
import { ImageEditLayer } from "./ImageEditLayer.js";
import type { EditableText, PageImage } from "@pdf-suite/engine/pdfium";
import type { TextRun } from "@pdf-suite/engine";
import { PageCanvas } from "./PageCanvas.js";
import { useVisibleRange } from "./use-visible-range.js";

export interface PageSize {
  width: number;
  height: number;
}

/** A box in PDF points, origin at the page's bottom-left. */
export interface Highlight {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewerProps {
  /** Source page indices in display order. */
  order: number[];
  pageSizes: PageSize[];
  render: (page: number, scale: number) => Promise<ImageBitmap>;
  /** CSS pixels available for a page; used by the "fit" zoom. */
  containerWidth: number;
  /** CSS pixels of visible height; used by the "page" zoom. */
  containerHeight?: number;
  pixelRatio?: number;
  /**
   * "fit" scales the widest page to the container width, "page" fits a whole
   * page in view, a number is a fixed scale in CSS pixels per point.
   */
  zoom?: number | "fit" | "page";
  /** Boxes to mark, keyed by display position. */
  highlights?: ReadonlyMap<number, Highlight[]>;
  /** The one highlight to emphasise, as "position:index". */
  active?: string | undefined;
  /** Display position to scroll into view; changing it scrolls. */
  scrollTo?: number | undefined;
  /** Annotations not yet written into the document, drawn as a preview. */
  annotations?: Annotation[];
  /** Active annotation tool; when set, dragging or clicking a page places one. */
  tool?: AnnotationTool | undefined;
  /** Areas marked for redaction, keyed by source page. */
  redactions?: ReadonlyMap<number, { x: number; y: number; w: number; h: number }[]>;
  onPlace?: ((page: number, shape: PlacedShape) => void) | undefined;
  onRemoveAnnotation?: ((index: number) => void) | undefined;
  /** When set, pages show their editable text runs instead of annotation tools. */
  editing?: boolean;
  /** Editable runs by source page; undefined for a page still being read. */
  editableText?: ReadonlyMap<number, EditableText[]>;
  /** Asks for a page's runs when it comes into view. */
  onNeedEditableText?: ((page: number) => void) | undefined;
  onEditText?: ((page: number, edit: TextEditCommit) => void) | undefined;
  /** Right-click on a page, for the actions that apply to it. */
  onPageMenu?: ((position: number, x: number, y: number) => void) | undefined;
  /**
   * Extracted text per source page, laid over the canvas so it can be selected
   * and copied. Undefined for a page whose text has not been read yet.
   */
  text?: ReadonlyMap<number, TextRun[]> | undefined;
  /** Asked for the text of a page that has come into view. */
  onNeedText?: ((page: number) => void) | undefined;
  /** The first page now in view, as a display position. */
  onVisible?: ((position: number) => void) | undefined;
  /** Two pages side by side, as a book opens. */
  facing?: boolean | undefined;
  /** Editing pictures: the images per source page, and what to do with them. */
  editingImages?: boolean | undefined;
  images?: ReadonlyMap<number, PageImage[]> | undefined;
  onNeedImages?: ((page: number) => void) | undefined;
  onPlaceImage?:
    | ((page: number, index: number, box: { x: number; y: number; w: number; h: number }) => void)
    | undefined;
  onRemoveImage?: ((page: number, index: number) => void) | undefined;
}

const GAP = 16;

function pageHeightOf(page: number, pageSizes: PageSize[]): number {
  return pageSizes[page]?.height ?? 792;
}

export function Viewer({
  order,
  pageSizes,
  render,
  containerWidth,
  containerHeight,
  pixelRatio = 1,
  zoom = "fit",
  highlights,
  active,
  scrollTo,
  annotations,
  tool,
  redactions,
  onPlace,
  onRemoveAnnotation,
  editing,
  editableText,
  onNeedEditableText,
  onEditText,
  onPageMenu,
  text,
  onNeedText,
  onVisible,
  facing,
  editingImages,
  images,
  onNeedImages,
  onPlaceImage,
  onRemoveImage,
}: ViewerProps) {
  const widest = useMemo(
    () => Math.max(1, ...order.map((page) => pageSizes[page]?.width ?? 0)),
    [order, pageSizes],
  );
  const tallest = useMemo(
    () => Math.max(1, ...order.map((page) => pageSizes[page]?.height ?? 0)),
    [order, pageSizes],
  );
  // Fit never magnifies past one point per CSS pixel; an explicit zoom may.
  const fitWidth = Math.min(1, Math.max(0.1, (containerWidth - GAP * 2) / widest));
  const scale =
    zoom === "fit"
      ? fitWidth
      : zoom === "page"
        ? Math.min(fitWidth, Math.max(0.1, ((containerHeight ?? 0) - GAP * 2) / tallest))
        : zoom;

  const layout = useMemo(() => {
    const offsets = [0];
    const sizes = order.map((page) => {
      const size = pageSizes[page] ?? { width: 612, height: 792 };
      return {
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale),
      };
    });

    const boxes = order.map((page, position) => {
      const size = sizes[position]!;
      // Facing pages share a row: the even one sits left of centre, the odd one
      // right of it, and the row is as tall as the taller of the two.
      const partner = facing ? sizes[position % 2 === 0 ? position + 1 : position - 1] : undefined;
      const rowHeight = Math.max(size.height, partner?.height ?? 0);
      const shift = !facing
        ? 0
        : position % 2 === 0
          ? -(size.width / 2) - GAP / 2
          : size.width / 2 + GAP / 2;

      // In facing mode the second page of a row starts at the same offset as
      // the first, and only the row advances.
      offsets.push(
        facing && position % 2 === 0
          ? (offsets[position] ?? 0)
          : (offsets[position] ?? 0) + rowHeight + GAP,
      );
      return { page, position, ...size, shift };
    });
    return { boxes, offsets };
  }, [facing, order, pageSizes, scale]);

  /** Pending annotations grouped by source page, keeping their list index. */
  const byPage = useMemo(() => {
    const map = new Map<number, { annotation: Annotation; index: number }[]>();
    (annotations ?? []).forEach((annotation, index) => {
      const list = map.get(annotation.page) ?? [];
      list.push({ annotation, index });
      map.set(annotation.page, list);
    });
    return map;
  }, [annotations]);

  const { ref, range, total, scrollToOffset } = useVisibleRange(layout.offsets);

  // Ask for the runs of pages that are on screen, and only those: reading them
  // means parsing the page's content stream.
  useEffect(() => {
    if (!editing || !onNeedEditableText) return;
    for (const box of layout.boxes.slice(range.start, range.end + 1)) {
      if (!editableText?.has(box.page)) onNeedEditableText(box.page);
    }
  }, [editing, editableText, layout.boxes, onNeedEditableText, range.end, range.start]);

  // Which page the reader is looking at, for the page box and for anything
  // that acts on "this page".
  useEffect(() => {
    onVisible?.(range.start);
  }, [onVisible, range.start]);

  // Editing pictures needs the pictures of the pages on screen, read once each.
  useEffect(() => {
    if (!editingImages || !onNeedImages) return;
    for (const box of layout.boxes.slice(range.start, range.end + 1)) {
      if (!images?.has(box.page)) onNeedImages(box.page);
    }
  }, [editingImages, images, layout.boxes, onNeedImages, range.end, range.start]);

  // Selecting text needs the text of the pages on screen, read once each.
  useEffect(() => {
    if (!onNeedText) return;
    for (const box of layout.boxes.slice(range.start, range.end + 1)) {
      if (!text?.has(box.page)) onNeedText(box.page);
    }
  }, [layout.boxes, onNeedText, range.end, range.start, text]);

  // Jumping to a search hit scrolls the page into view; the window of mounted
  // pages follows from the new scroll position as usual.
  useEffect(() => {
    if (scrollTo === undefined) return;
    scrollToOffset(layout.offsets[scrollTo] ?? 0);
  }, [scrollTo, layout.offsets, scrollToOffset]);

  return (
    <div className="viewer" ref={ref} data-testid="viewer">
      <div className="viewer-canvas" style={{ height: `${total}px` }}>
        {layout.boxes.slice(range.start, range.end + 1).map((box) => (
          <div
            key={`${box.position}:${box.page}`}
            className="viewer-page"
            style={{
              top: `${layout.offsets[box.position] ?? 0}px`,
              width: `${box.width}px`,
              height: `${box.height}px`,
              transform: `translateX(calc(-50% + ${box.shift}px))`,
            }}
            data-page-position={box.position}
            onContextMenu={(event) => {
              if (!onPageMenu) return;
              event.preventDefault();
              onPageMenu(box.position, event.clientX, event.clientY);
            }}
          >
            <PageCanvas
              page={box.page}
              width={box.width}
              height={box.height}
              pixelRatio={scale * pixelRatio}
              render={render}
              label={`Page ${box.position + 1}`}
            />
            <TextLayer
              page={box.page}
              pageHeight={pageSizes[box.page]?.height ?? 792}
              scale={scale}
              runs={text?.get(box.page)}
            />
            {editingImages ? (
              <ImageEditLayer
                page={box.page}
                pageHeight={pageSizes[box.page]?.height ?? 792}
                scale={scale}
                images={images?.get(box.page)}
                onPlace={(page, index, area) => onPlaceImage?.(page, index, area)}
                onRemove={(page, index) => onRemoveImage?.(page, index)}
              />
            ) : null}
            {editing ? (
              <TextEditLayer
                page={box.page}
                pageHeight={pageSizes[box.page]?.height ?? 792}
                scale={scale}
                runs={editableText?.get(box.page)}
                onCommit={(page, edit) => onEditText?.(page, edit)}
              />
            ) : null}
            <AnnotationLayer
              page={box.page}
              pageHeight={pageSizes[box.page]?.height ?? 792}
              scale={scale}
              tool={tool}
              annotations={byPage.get(box.page) ?? []}
              redactions={redactions?.get(box.page) ?? []}
              onPlace={onPlace}
              onRemove={onRemoveAnnotation}
            />
            {(highlights?.get(box.position) ?? []).map((mark, index) => (
              <div
                key={`${mark.x}:${mark.y}:${index}`}
                className={
                  "highlight" + (active === `${box.position}:${index}` ? " highlight-active" : "")
                }
                data-testid={`highlight-${box.position}-${index}`}
                style={{
                  left: `${mark.x * scale}px`,
                  // PDF coordinates start at the bottom of the page, CSS at the top.
                  top: `${(pageHeightOf(box.page, pageSizes) - mark.y - mark.h) * scale}px`,
                  width: `${mark.w * scale}px`,
                  height: `${mark.h * scale}px`,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
