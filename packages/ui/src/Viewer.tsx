import { useMemo } from "react";
import { PageCanvas } from "./PageCanvas.js";
import { useVisibleRange } from "./use-visible-range.js";

export interface PageSize {
  width: number;
  height: number;
}

export interface ViewerProps {
  /** Source page indices in display order. */
  order: number[];
  pageSizes: PageSize[];
  render: (page: number, scale: number) => Promise<ImageBitmap>;
  /** CSS pixels available for a page; pages are scaled to fit this width. */
  containerWidth: number;
  pixelRatio?: number;
}

const GAP = 16;

export function Viewer({ order, pageSizes, render, containerWidth, pixelRatio = 1 }: ViewerProps) {
  const widest = useMemo(
    () => Math.max(1, ...order.map((page) => pageSizes[page]?.width ?? 0)),
    [order, pageSizes],
  );
  // Fit to width, never magnifying past 1 point per CSS pixel.
  const scale = Math.min(1, Math.max(0.1, (containerWidth - GAP * 2) / widest));

  const layout = useMemo(() => {
    const offsets = [0];
    const boxes = order.map((page, position) => {
      const size = pageSizes[page] ?? { width: 612, height: 792 };
      const box = {
        page,
        position,
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale),
      };
      offsets.push((offsets[position] ?? 0) + box.height + GAP);
      return box;
    });
    return { boxes, offsets };
  }, [order, pageSizes, scale]);

  const { ref, range, total } = useVisibleRange(layout.offsets);

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
            }}
            data-page-position={box.position}
          >
            <PageCanvas
              page={box.page}
              width={box.width}
              height={box.height}
              pixelRatio={scale * pixelRatio}
              render={render}
              label={`Page ${box.position + 1}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
