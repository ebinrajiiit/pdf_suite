import { useState } from "react";
import type { PageImage } from "@pdf-suite/engine/pdfium";

export interface ImageEditLayerProps {
  /** Source page index. */
  page: number;
  /** Page height in PDF points, to flip the origin. */
  pageHeight: number;
  /** CSS pixels per PDF point. */
  scale: number;
  /** Images on this page, or undefined while they are still being read. */
  images: PageImage[] | undefined;
  /** Called with the image's new box in PDF points. */
  onPlace: (
    page: number,
    index: number,
    box: { x: number; y: number; w: number; h: number },
  ) => void;
  onRemove: (page: number, index: number) => void;
  /** Replaces the picture while keeping its frame. */
  onReplace?: ((page: number, index: number) => void) | undefined;
  /** Turns the picture a quarter clockwise, about the centre of its box. */
  onTurn?: ((page: number, index: number) => void) | undefined;
}

/** Below this, a drag is a click that selected the image rather than moved it. */
const NUDGE = 3;

/**
 * Move, resize and remove the pictures on a page, which is the half of "Edit
 * PDF" that is not text.
 *
 * An image is a unit square drawn through a matrix, so moving and resizing are
 * changes to that matrix and never touch the picture itself. Dragging the box
 * moves it; dragging the corner resizes it; the button on the selection
 * removes it. The change is applied when the pointer is released, because each
 * one rewrites the document.
 */
export function ImageEditLayer({
  page,
  pageHeight,
  scale,
  images,
  onPlace,
  onRemove,
  onReplace,
  onTurn,
}: ImageEditLayerProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<{
    index: number;
    mode: "move" | "resize";
    fromX: number;
    fromY: number;
    box: { x: number; y: number; w: number; h: number };
  } | null>(null);

  if (!images) return <div className="imagelayer" data-testid={`images-${page}`} />;

  /** PDF points from the bottom to CSS pixels from the top. */
  const top = (image: { y: number; h: number }) => (pageHeight - image.y - image.h) * scale;

  /** The box being dragged, in PDF points, or the stored one. */
  const boxOf = (image: PageImage) =>
    drag && drag.index === image.index
      ? drag.box
      : { x: image.x, y: image.y, w: image.w, h: image.h };

  const move = (event: React.PointerEvent) => {
    if (!drag) return;
    const dx = (event.clientX - drag.fromX) / scale;
    // Screen y grows downwards, the page's grows upwards.
    const dy = -(event.clientY - drag.fromY) / scale;
    setDrag((current) => {
      if (!current) return current;
      const base = current.box;
      if (current.mode === "move") {
        return {
          ...current,
          box: { ...base, x: base.x + dx, y: base.y + dy },
          fromX: event.clientX,
          fromY: event.clientY,
        };
      }
      // Resizing from the bottom-right keeps the top-left corner still, so the
      // picture grows the way the pointer moves.
      const w = Math.max(4, base.w + dx);
      const h = Math.max(4, base.h - dy);
      return {
        ...current,
        box: { x: base.x, y: base.y + (base.h - h), w, h },
        fromX: event.clientX,
        fromY: event.clientY,
      };
    });
  };

  const release = (image: PageImage) => {
    if (!drag || drag.index !== image.index) return;
    const box = drag.box;
    setDrag(null);
    const moved =
      Math.abs(box.x - image.x) > NUDGE / scale ||
      Math.abs(box.y - image.y) > NUDGE / scale ||
      Math.abs(box.w - image.w) > NUDGE / scale ||
      Math.abs(box.h - image.h) > NUDGE / scale;
    if (moved) onPlace(page, image.index, box);
  };

  return (
    <div className="imagelayer" data-testid={`images-${page}`}>
      {images.map((image) => {
        const box = boxOf(image);
        const isSelected = selected === image.index;
        return (
          <div
            key={image.index}
            className={isSelected ? "imagebox imagebox-on" : "imagebox"}
            data-testid={`image-${image.index}`}
            style={{
              left: `${box.x * scale}px`,
              top: `${top(box)}px`,
              width: `${box.w * scale}px`,
              height: `${box.h * scale}px`,
            }}
            title={`${image.pixelWidth}×${image.pixelHeight} picture — drag to move, corner to resize`}
            data-selected={isSelected ? "" : undefined}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setSelected(image.index);
              setDrag({
                index: image.index,
                mode: "move",
                fromX: event.clientX,
                fromY: event.clientY,
                box: { x: image.x, y: image.y, w: image.w, h: image.h },
              });
            }}
            onPointerMove={move}
            onPointerUp={() => release(image)}
            onPointerCancel={() => setDrag(null)}
          >
            {isSelected ? (
              <>
                <button
                  type="button"
                  className="imagebox-remove"
                  data-testid={`image-remove-${image.index}`}
                  aria-label="Remove this image"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    setSelected(null);
                    onRemove(page, image.index);
                  }}
                >
                  ✕
                </button>
                {onTurn ? (
                  <button
                    type="button"
                    className="imagebox-turn"
                    data-testid={`image-turn-${image.index}`}
                    aria-label="Turn this picture a quarter to the right"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onTurn(page, image.index)}
                  >
                    ↻
                  </button>
                ) : null}
                {onReplace ? (
                  <button
                    type="button"
                    className="imagebox-replace"
                    data-testid={`image-replace-${image.index}`}
                    aria-label="Replace this picture"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onReplace(page, image.index)}
                  >
                    ⇄
                  </button>
                ) : null}
                <span
                  className="imagebox-handle"
                  data-testid={`image-handle-${image.index}`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDrag({
                      index: image.index,
                      mode: "resize",
                      fromX: event.clientX,
                      fromY: event.clientY,
                      box: { x: image.x, y: image.y, w: image.w, h: image.h },
                    });
                  }}
                  onPointerMove={move}
                  onPointerUp={() => release(image)}
                />
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
