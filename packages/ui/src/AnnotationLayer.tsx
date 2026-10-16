import { useRef, useState } from "react";
import type { Annotation, AnnotRect } from "@pdf-suite/core";

export type AnnotationTool =
  | "highlight"
  | "underline"
  | "strike"
  | "note"
  | "text"
  | "square"
  | "circle"
  | "ink"
  /** Marks an area whose content will be removed. Not a PDF annotation. */
  | "redact";

/** Tools that are drawn by dragging a box. */
const BOX_TOOLS = new Set<AnnotationTool>([
  "highlight",
  "underline",
  "strike",
  "square",
  "circle",
  "redact",
]);

/** A CSS colour from an annotation's 0-1 RGB triple. */
function rgb(color?: [number, number, number]): string {
  const [r, g, b] = color ?? [0.85, 0.15, 0.15];
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

/** What the user drew, in PDF points with the origin at the page bottom-left. */
export type PlacedShape =
  | { kind: "rect"; rect: AnnotRect }
  | { kind: "point"; x: number; y: number }
  /** A freehand stroke, in PDF points. */
  | { kind: "stroke"; points: { x: number; y: number }[] };

export interface AnnotationLayerProps {
  /** Source page index. */
  page: number;
  /** Page size in PDF points, rotation applied. */
  pageHeight: number;
  /** CSS pixels per PDF point. */
  scale: number;
  tool?: AnnotationTool | undefined;
  /** Pending annotations for this page, with their index in the whole list. */
  annotations: { annotation: Annotation; index: number }[];
  /** Areas marked for redaction on this page, drawn opaque. */
  redactions?: AnnotRect[];
  onPlace?: ((page: number, shape: PlacedShape) => void) | undefined;
  /** Removing by list index, so the caller does not have to identify by geometry. */
  onRemove?: ((index: number) => void) | undefined;
}

/**
 * Draws pending annotations over a page and turns pointer gestures into
 * geometry. Annotations are not written into the document until it is saved, so
 * what this draws is a preview of what the file will contain.
 */
export function AnnotationLayer({
  page,
  pageHeight,
  scale,
  tool,
  annotations,
  redactions,
  onPlace,
  onRemove,
}: AnnotationLayerProps) {
  const layer = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  /** Freehand points in CSS pixels while the pen is down. */
  const [stroke, setStroke] = useState<{ x: number; y: number }[] | null>(null);

  /** Pointer position in CSS pixels relative to the page. */
  const positionIn = (event: React.PointerEvent) => {
    const box = layer.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  /** CSS pixels from the page's top-left to PDF points from its bottom-left. */
  const toPdf = (x: number, y: number) => ({ x: x / scale, y: pageHeight - y / scale });

  const finishDrag = () => {
    if (!drag) return;
    setDrag(null);
    const left = Math.min(drag.x1, drag.x2);
    const right = Math.max(drag.x1, drag.x2);
    const top = Math.min(drag.y1, drag.y2);
    const bottom = Math.max(drag.y1, drag.y2);
    // A click rather than a drag: too small to be a deliberate box.
    if (right - left < 4 || bottom - top < 4) return;
    const topLeft = toPdf(left, top);
    const bottomRight = toPdf(right, bottom);
    onPlace?.(page, {
      kind: "rect",
      rect: {
        x: topLeft.x,
        y: bottomRight.y,
        w: bottomRight.x - topLeft.x,
        h: topLeft.y - bottomRight.y,
      },
    });
  };

  return (
    <div
      ref={layer}
      className={tool ? `annots annots-${tool}` : "annots"}
      data-testid={`annots-${page}`}
      onPointerDown={(event) => {
        const { x, y } = positionIn(event);
        if (tool === "ink") {
          event.currentTarget.setPointerCapture(event.pointerId);
          setStroke([{ x, y }]);
          return;
        }
        if (!tool || !BOX_TOOLS.has(tool)) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ x1: x, y1: y, x2: x, y2: y });
      }}
      onPointerMove={(event) => {
        const { x, y } = positionIn(event);
        if (stroke) {
          // Drop points closer than a pixel: a pen emits far more than the shape
          // needs, and every one of them ends up in the PDF.
          const last = stroke[stroke.length - 1];
          if (!last || Math.hypot(x - last.x, y - last.y) >= 1.5) {
            setStroke((current) => (current ? [...current, { x, y }] : current));
          }
          return;
        }
        if (!drag) return;
        setDrag((current) => (current ? { ...current, x2: x, y2: y } : null));
      }}
      onPointerUp={() => {
        if (stroke) {
          const points = stroke;
          setStroke(null);
          if (points.length >= 2) {
            onPlace?.(page, { kind: "stroke", points: points.map((p) => toPdf(p.x, p.y)) });
          }
          return;
        }
        finishDrag();
      }}
      onPointerCancel={() => {
        setDrag(null);
        setStroke(null);
      }}
      onClick={(event) => {
        if (tool !== "note" && tool !== "text") return;
        const box = layer.current?.getBoundingClientRect();
        const point = toPdf(event.clientX - (box?.left ?? 0), event.clientY - (box?.top ?? 0));
        onPlace?.(page, { kind: "point", ...point });
      }}
    >
      {annotations.map(({ annotation, index }) => {
        /** PDF points from the bottom to CSS pixels from the top. */
        const top = (y: number, h: number) => (pageHeight - y) * scale - h * scale;
        const common = {
          key: index,
          role: onRemove ? "button" : undefined,
          tabIndex: onRemove ? 0 : undefined,
          title: onRemove ? "Click to remove" : undefined,
          onClick: onRemove ? () => onRemove(index) : undefined,
        };

        if (
          annotation.kind === "highlight" ||
          annotation.kind === "underline" ||
          annotation.kind === "strike"
        ) {
          return annotation.rects.map((rect: AnnotRect, n: number) => (
            <div
              {...common}
              key={`${index}:${n}`}
              className={`annot annot-${annotation.kind}`}
              data-testid={`annot-${index}`}
              style={{
                left: `${rect.x * scale}px`,
                top: `${top(rect.y + rect.h, 0)}px`,
                width: `${rect.w * scale}px`,
                height: `${rect.h * scale}px`,
              }}
            />
          ));
        }

        if (annotation.kind === "square" || annotation.kind === "circle") {
          return (
            <div
              {...common}
              className={`annot annot-${annotation.kind}`}
              data-testid={`annot-${index}`}
              style={{
                left: `${annotation.x * scale}px`,
                top: `${top(annotation.y + annotation.h, 0)}px`,
                width: `${annotation.w * scale}px`,
                height: `${annotation.h * scale}px`,
                borderColor: rgb(annotation.color),
              }}
            />
          );
        }

        if (annotation.kind === "ink") {
          // One SVG per annotation, positioned over the page in CSS pixels.
          const points = annotation.strokes.flat();
          const xs = points.map((p) => p.x);
          const ys = points.map((p) => p.y);
          const left = Math.min(...xs);
          const bottom = Math.min(...ys);
          const wide = Math.max(...xs) - left || 1;
          const tall = Math.max(...ys) - bottom || 1;
          return (
            <svg
              {...common}
              className="annot annot-ink"
              data-testid={`annot-${index}`}
              style={{
                left: `${left * scale}px`,
                top: `${top(bottom + tall, 0)}px`,
                width: `${wide * scale}px`,
                height: `${tall * scale}px`,
              }}
              viewBox={`0 0 ${wide} ${tall}`}
              preserveAspectRatio="none"
            >
              {annotation.strokes.map((s, n) => (
                <polyline
                  key={n}
                  points={s.map((p) => `${p.x - left},${tall - (p.y - bottom)}`).join(" ")}
                  fill="none"
                  stroke={rgb(annotation.color)}
                  strokeWidth={annotation.width ?? 2}
                  strokeLinecap="round"
                />
              ))}
            </svg>
          );
        }

        if (annotation.kind === "note") {
          const size = 24 * scale;
          return (
            <div
              {...common}
              className="annot annot-note"
              data-testid={`annot-${index}`}
              style={{
                left: `${annotation.x * scale}px`,
                top: `${top(annotation.y, 24)}px`,
                width: `${size}px`,
                height: `${size}px`,
              }}
            >
              <span aria-hidden="true">●</span>
              <span className="annot-tip">{annotation.contents}</span>
            </div>
          );
        }

        return (
          <div
            {...common}
            className="annot annot-text"
            data-testid={`annot-${index}`}
            style={{
              left: `${annotation.x * scale}px`,
              top: `${top(annotation.y, annotation.h)}px`,
              width: `${annotation.w * scale}px`,
              minHeight: `${annotation.h * scale}px`,
              fontSize: `${(annotation.size ?? 12) * scale}px`,
            }}
          >
            {annotation.contents}
          </div>
        );
      })}

      {stroke && stroke.length > 1 ? (
        <svg className="annot annot-ink annot-dragging-ink" style={{ inset: 0 }}>
          <polyline
            points={stroke.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="#d92626"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </svg>
      ) : null}

      {(redactions ?? []).map((rect, index) => (
        <div
          key={`redact:${index}`}
          className="annot annot-redact"
          data-testid={`redact-${page}-${index}`}
          style={{
            left: `${rect.x * scale}px`,
            top: `${(pageHeight - rect.y - rect.h) * scale}px`,
            width: `${rect.w * scale}px`,
            height: `${rect.h * scale}px`,
          }}
        />
      ))}

      {drag ? (
        <div
          className={
            tool === "redact" ? "annot annot-dragging annot-redact" : "annot annot-dragging"
          }
          style={{
            left: `${Math.min(drag.x1, drag.x2)}px`,
            top: `${Math.min(drag.y1, drag.y2)}px`,
            width: `${Math.abs(drag.x2 - drag.x1)}px`,
            height: `${Math.abs(drag.y2 - drag.y1)}px`,
          }}
        />
      ) : null}
    </div>
  );
}
