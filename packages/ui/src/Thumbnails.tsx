import { useMemo, useState } from "react";
import { PageCanvas } from "./PageCanvas.js";
import { useVisibleRange } from "./use-visible-range.js";
import type { PageSize } from "./Viewer.js";

export interface ThumbnailsProps {
  order: number[];
  pageSizes: PageSize[];
  render: (page: number, scale: number) => Promise<ImageBitmap>;
  /** Called with the new display order. */
  onReorder: (order: number[]) => void;
  width?: number;
}

const GAP = 12;
const LABEL_HEIGHT = 20;

function move(order: number[], from: number, to: number): number[] {
  if (to < 0 || to >= order.length || from === to) return order;
  const next = [...order];
  const [page] = next.splice(from, 1);
  next.splice(to, 0, page!);
  return next;
}

export function Thumbnails({ order, pageSizes, render, onReorder, width = 120 }: ThumbnailsProps) {
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
            className={`thumb${dragging === box.position ? " thumb-dragging" : ""}`}
            style={{ top: `${layout.offsets[box.position] ?? 0}px`, width: `${box.width}px` }}
            data-testid={`thumb-${box.position}`}
            draggable
            onDragStart={() => setDragging(box.position)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging !== null) onReorder(move(order, dragging, box.position));
              setDragging(null);
            }}
          >
            <PageCanvas
              page={box.page}
              width={box.width}
              height={box.height}
              pixelRatio={box.scale}
              render={render}
              label={`Page ${box.position + 1} thumbnail`}
            />
            <div className="thumb-bar">
              <span>{box.position + 1}</span>
              {/* Dragging is mouse-only, so the same move is reachable by keyboard. */}
              <button
                type="button"
                aria-label={`Move page ${box.position + 1} up`}
                disabled={box.position === 0}
                onClick={() => onReorder(move(order, box.position, box.position - 1))}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move page ${box.position + 1} down`}
                disabled={box.position === order.length - 1}
                onClick={() => onReorder(move(order, box.position, box.position + 1))}
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
