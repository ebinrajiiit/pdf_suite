import { useMemo, useState } from "react";
import { PageCanvas } from "./PageCanvas.js";
import { movePage } from "./page-order.js";
import { useVisibleRange } from "./use-visible-range.js";
import type { PageSize } from "./Viewer.js";

export interface ThumbnailsProps {
  order: number[];
  pageSizes: PageSize[];
  render: (page: number, scale: number) => Promise<ImageBitmap>;
  /** Called with the new display order. */
  onReorder: (order: number[]) => void;
  /** Selected display positions. */
  selected: ReadonlySet<number>;
  /** Called with the position clicked and whether the click extends the selection. */
  onSelect: (position: number, extend: boolean) => void;
  width?: number;
}

const GAP = 12;
const LABEL_HEIGHT = 20;

export function Thumbnails({
  order,
  pageSizes,
  render,
  onReorder,
  selected,
  onSelect,
  width = 120,
}: ThumbnailsProps) {
  const [dragging, setDragging] = useState<number | null>(null);

  const layout = useMemo(() => {
    const offsets = [0];
    const boxes = order.map((page, position) => {
      const size = pageSizes[page] ?? { width: 612, height: 792 };
      const scale = width / size.width;
      const box = { page, position, width, height: Math.round(size.height * scale), scale };
      offsets.push((offsets[position] ?? 0) + box.height + LABEL_HEIGHT + GAP);
      return box;
    });
    return { boxes, offsets };
  }, [order, pageSizes, width]);

  const { ref, range, total } = useVisibleRange(layout.offsets, 2);

  return (
    <div className="thumbs" ref={ref} data-testid="thumbnails">
      <ol className="thumbs-canvas" style={{ height: `${total}px` }} aria-label="Pages">
        {layout.boxes.slice(range.start, range.end + 1).map((box) => (
          <li
            key={`${box.position}:${box.page}`}
            className={
              "thumb" +
              (dragging === box.position ? " thumb-dragging" : "") +
              (selected.has(box.position) ? " thumb-selected" : "")
            }
            style={{ top: `${layout.offsets[box.position] ?? 0}px`, width: `${box.width}px` }}
            data-testid={`thumb-${box.position}`}
            draggable
            onDragStart={() => setDragging(box.position)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging !== null) onReorder(movePage(order, dragging, box.position));
              setDragging(null);
            }}
          >
            {/* The thumbnail itself selects the page, so it is a real button
                rather than a click handler on the list item. */}
            <button
              type="button"
              className="thumb-select"
              aria-label={`Select page ${box.position + 1}`}
              aria-pressed={selected.has(box.position)}
              data-testid={`select-${box.position}`}
              onClick={(event) =>
                onSelect(box.position, event.shiftKey || event.metaKey || event.ctrlKey)
              }
            >
              <PageCanvas
                page={box.page}
                width={box.width}
                height={box.height}
                pixelRatio={box.scale}
                render={render}
                label={`Page ${box.position + 1} thumbnail`}
              />
            </button>
            <div className="thumb-bar">
              <span>{box.position + 1}</span>
              {/* Dragging is mouse-only, so the same move is reachable by keyboard. */}
              <button
                type="button"
                aria-label={`Move page ${box.position + 1} up`}
                disabled={box.position === 0}
                onClick={() => onReorder(movePage(order, box.position, box.position - 1))}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move page ${box.position + 1} down`}
                disabled={box.position === order.length - 1}
                onClick={() => onReorder(movePage(order, box.position, box.position + 1))}
              >
                ↓
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
