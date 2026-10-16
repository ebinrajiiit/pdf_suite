import { useEffect, useRef } from "react";

export interface PageCanvasProps {
  /** Source page index, which is not the display position once pages are reordered. */
  page: number;
  width: number;
  height: number;
  /** Device pixels per CSS pixel to rasterise at. */
  pixelRatio: number;
  render: (page: number, scale: number) => Promise<ImageBitmap>;
  className?: string;
  label?: string;
}

/**
 * Draws one page. The bitmap arrives from the worker already rasterised and is
 * transferred into the canvas, so no pixels are copied on the main thread.
 */
export function PageCanvas({
  page,
  width,
  height,
  pixelRatio,
  render,
  className,
  label,
}: PageCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let alive = true;

    void render(page, pixelRatio)
      .then((bitmap) => {
        if (!alive) {
          // Scrolled away before it arrived; dropping it beats holding the memory.
          bitmap.close();
          return;
        }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("bitmaprenderer");
        if (ctx) ctx.transferFromImageBitmap(bitmap);
        else bitmap.close();
      })
      .catch(() => {
        // A failed page must not take the viewer down; it stays blank.
      });

    return () => {
      alive = false;
    };
  }, [page, pixelRatio, render]);

  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width: `${width}px`, height: `${height}px` }}
      aria-label={label ?? `Page ${page + 1}`}
      role="img"
    />
  );
}
