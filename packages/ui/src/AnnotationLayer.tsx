import { useEffect, useMemo, useRef, useState } from "react";
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
  | "line"
  | "arrow"
  | "polygon"
  | "cloud"
  | "polyline"
  | "measure"
  | "measurearea"
  | "callout"
  | "caret"
  | "stamp"
  | "signature"
  /** Stamps a page with a picture: a seal, a scanned signature, a logo. */
  | "picture"
  /** Pins a file to a point on the page. The worker writes it, not this layer. */
  | "attachment"
  /** Marks an area whose content will be removed. Not a PDF annotation. */
  | "redact"
  /** Marks what to keep of the page. Not a PDF annotation either. */
  | "crop"
  /** Draws a form field where the box is. Not an annotation either. */
  | "field"
  /** Draws a link box. Not an annotation this layer owns either. */
  | "link";

/** Tools drawn by dragging from one point to another, where direction matters. */
const VECTOR_TOOLS = new Set<AnnotationTool>(["line", "arrow", "measure"]);
/** Tools placed with a single click. */
const POINT_TOOLS = new Set<AnnotationTool>([
  "note",
  "text",
  "stamp",
  "signature",
  "callout",
  "caret",
  "picture",
  "attachment",
]);

/** Tools built point by point: click each corner, double-click to finish. */
const PATH_TOOLS = new Set<AnnotationTool>(["polygon", "cloud", "polyline", "measurearea"]);

/** Tools that are drawn by dragging a box. */
const BOX_TOOLS = new Set<AnnotationTool>([
  "highlight",
  "underline",
  "strike",
  "square",
  "circle",
  "redact",
  "crop",
  "field",
  "link",
  "picture",
]);

/** A CSS colour from an annotation's 0-1 RGB triple. */
function rgb(color?: [number, number, number]): string {
  const [r, g, b] = color ?? [0.85, 0.15, 0.15];
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

/** What the user drew, in PDF points with the origin at the page bottom-left. */
export type PlacedShape =
  | { kind: "rect"; rect: AnnotRect }
  /** A path clicked out point by point, in PDF points. */
  | { kind: "path"; points: { x: number; y: number }[] }
  | { kind: "point"; x: number; y: number }
  /** A line from where the drag started to where it ended; direction matters. */
  | { kind: "vector"; x1: number; y1: number; x2: number; y2: number }
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
  /** Points clicked so far for a polygon, cloud or polyline, in CSS pixels. */
  const [path, setPath] = useState<{ x: number; y: number }[]>([]);
  /** Where the pointer is while a path is being built, for the rubber band. */
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  /**
   * Set when a drag just placed a box. A pointer-up is followed by a click, and
   * "picture" is in both BOX_TOOLS and POINT_TOOLS, so without this a drag would
   * place the picture twice: once at the size drawn, once at the default.
   */
  const boxed = useRef(false);

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
    if (tool && VECTOR_TOOLS.has(tool)) {
      // Too short to be deliberate, in either direction.
      if (Math.hypot(drag.x2 - drag.x1, drag.y2 - drag.y1) < 6) return;
      const from = toPdf(drag.x1, drag.y1);
      const to = toPdf(drag.x2, drag.y2);
      onPlace?.(page, { kind: "vector", x1: from.x, y1: from.y, x2: to.x, y2: to.y });
      return;
    }
    const left = Math.min(drag.x1, drag.x2);
    const right = Math.max(drag.x1, drag.x2);
    const top = Math.min(drag.y1, drag.y2);
    const bottom = Math.max(drag.y1, drag.y2);
    // A click rather than a drag: too small to be a deliberate box. A picture
    // needs more slop than the rest — a click meant to drop one at the default
    // size usually moves the pointer a pixel or two, and a 6-point-wide picture
    // is never what anyone meant.
    const slop = tool === "picture" ? 16 : 4;
    if (right - left < slop || bottom - top < slop) return;
    const topLeft = toPdf(left, top);
    const bottomRight = toPdf(right, bottom);
    boxed.current = true;
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
        if (!tool || !(BOX_TOOLS.has(tool) || VECTOR_TOOLS.has(tool))) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ x1: x, y1: y, x2: x, y2: y });
      }}
      onPointerMove={(event) => {
        const { x, y } = positionIn(event);
        if (path.length > 0) setHover({ x, y });
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
        const box = layer.current?.getBoundingClientRect();
        const at = {
          x: event.clientX - (box?.left ?? 0),
          y: event.clientY - (box?.top ?? 0),
        };
        if (tool && PATH_TOOLS.has(tool)) {
          // Each click adds a corner; the shape is finished by double-clicking,
          // which is how every drawing program does a polygon.
          setPath((current) => [...current, at]);
          return;
        }
        if (boxed.current) {
          boxed.current = false;
          return;
        }
        if (!tool || !POINT_TOOLS.has(tool)) return;
        onPlace?.(page, { kind: "point", ...toPdf(at.x, at.y) });
      }}
      onDoubleClick={() => {
        if (!tool || !PATH_TOOLS.has(tool) || path.length < 2) return;
        const points = path.map((point) => toPdf(point.x, point.y));
        setPath([]);
        setHover(null);
        onPlace?.(page, { kind: "path", points });
      }}
    >
      {path.length > 0 ? (
        <svg className="annot annot-path" data-testid={`path-${page}`} width="100%" height="100%">
          <polyline
            points={[...path, ...(hover ? [hover] : [])]
              .map((point) => `${point.x},${point.y}`)
              .join(" ")}
            fill="none"
            stroke={rgb()}
            strokeWidth={2}
            strokeDasharray="4 3"
          />
          {path.map((point, index) => (
            <circle key={index} cx={point.x} cy={point.y} r={3} fill={rgb()} />
          ))}
        </svg>
      ) : null}
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

        if (annotation.kind === "polygon" || annotation.kind === "polyline") {
          const closed = annotation.kind === "polygon";
          const points = annotation.points
            .map((point) => `${point.x * scale},${top(point.y, 0)}`)
            .join(" ");
          return closed ? (
            <svg
              {...common}
              className="annot annot-line"
              data-testid={`annot-${index}`}
              width="100%"
              height="100%"
            >
              {annotation.measurement ? (
                <text
                  x={
                    (annotation.points.reduce((sum, point) => sum + point.x, 0) /
                      annotation.points.length) *
                    scale
                  }
                  y={top(
                    annotation.points.reduce((sum, point) => sum + point.y, 0) /
                      annotation.points.length,
                    0,
                  )}
                  fontSize={9 * scale}
                  textAnchor="middle"
                  fill={rgb(annotation.color)}
                  stroke="white"
                  strokeWidth={3 * scale}
                  paintOrder="stroke"
                >
                  {annotation.measurement}
                </text>
              ) : null}
              <polygon
                points={points}
                fill="none"
                stroke={rgb(annotation.color)}
                strokeWidth={(annotation.width ?? 2) * scale}
                strokeDasharray={annotation.cloud ? "6 3" : undefined}
              />
            </svg>
          ) : (
            <svg
              {...common}
              className="annot annot-line"
              data-testid={`annot-${index}`}
              width="100%"
              height="100%"
            >
              <polyline
                points={points}
                fill="none"
                stroke={rgb(annotation.color)}
                strokeWidth={(annotation.width ?? 2) * scale}
              />
            </svg>
          );
        }

        if (annotation.kind === "callout") {
          return (
            <svg
              {...common}
              className="annot annot-line"
              data-testid={`annot-${index}`}
              width="100%"
              height="100%"
            >
              <polyline
                points={
                  `${annotation.tipX * scale},${top(annotation.tipY, 0)} ` +
                  `${((annotation.tipX + annotation.x) / 2) * scale},${top(annotation.tipY, 0)} ` +
                  `${annotation.x * scale},${top(annotation.y + annotation.h / 2, 0)}`
                }
                fill="none"
                stroke={rgb(annotation.color)}
                strokeWidth={2 * scale}
              />
              <rect
                x={annotation.x * scale}
                y={top(annotation.y + annotation.h, 0)}
                width={annotation.w * scale}
                height={annotation.h * scale}
                fill="white"
                fillOpacity={0.85}
                stroke={rgb(annotation.color)}
                strokeWidth={2 * scale}
              />
              <text
                x={(annotation.x + 3) * scale}
                y={top(annotation.y + annotation.h, 0) + (annotation.size ?? 11) * scale}
                fontSize={(annotation.size ?? 11) * scale}
                fill={rgb(annotation.color)}
              >
                {annotation.contents}
              </text>
            </svg>
          );
        }

        if (annotation.kind === "caret") {
          return (
            <div
              {...common}
              className="annot annot-caret"
              data-testid={`annot-${index}`}
              title={annotation.contents}
              style={{
                left: `${(annotation.x - 5) * scale}px`,
                top: `${top(annotation.y + 10, 0)}px`,
                width: `${10 * scale}px`,
                height: `${10 * scale}px`,
                color: rgb(annotation.color),
              }}
            />
          );
        }

        if (annotation.kind === "line") {
          // An SVG the size of the page: a diagonal line is not a box, and
          // drawing it with CSS would be a rotated div with the wrong hit area.
          const colour = rgb(annotation.color);
          const head = Math.max(6, (annotation.width ?? 2) * 3.5) * scale;
          return (
            <svg
              {...common}
              className="annot annot-line"
              data-testid={`annot-${index}`}
              width="100%"
              height="100%"
              style={{ left: 0, top: 0, width: "100%", height: "100%" }}
            >
              {annotation.measurement ? (
                <text
                  x={((annotation.x1 + annotation.x2) / 2) * scale}
                  y={top((annotation.y1 + annotation.y2) / 2, 0)}
                  fontSize={9 * scale}
                  textAnchor="middle"
                  fill={rgb(annotation.color)}
                  stroke="white"
                  strokeWidth={3 * scale}
                  paintOrder="stroke"
                >
                  {annotation.measurement}
                </text>
              ) : null}
              <line
                x1={annotation.x1 * scale}
                y1={top(annotation.y1, 0)}
                x2={annotation.x2 * scale}
                y2={top(annotation.y2, 0)}
                stroke={colour}
                strokeWidth={(annotation.width ?? 2) * scale}
                strokeLinecap="round"
                markerEnd={
                  annotation.arrow && annotation.arrow !== "none" ? "url(#arrow)" : undefined
                }
              />
              {annotation.arrow && annotation.arrow !== "none" ? (
                <defs>
                  <marker
                    id="arrow"
                    markerWidth={head}
                    markerHeight={head}
                    refX={head * 0.9}
                    refY={head / 2}
                    orient="auto"
                  >
                    <path d={`M0,0 L${head},${head / 2} L0,${head} z`} fill={colour} />
                  </marker>
                </defs>
              ) : null}
            </svg>
          );
        }

        if (annotation.kind === "stamp") {
          return (
            <div
              {...common}
              className="annot annot-stamp"
              data-testid={`annot-${index}`}
              style={{
                left: `${annotation.x * scale}px`,
                top: `${top(annotation.y + annotation.h, 0)}px`,
                width: `${annotation.w * scale}px`,
                height: `${annotation.h * scale}px`,
                color: rgb(annotation.color),
                borderColor: rgb(annotation.color),
                fontSize: `${annotation.h * scale * 0.5}px`,
              }}
            >
              {annotation.label.toUpperCase()}
            </div>
          );
        }

        if (annotation.kind === "picture") {
          return (
            <PictureStamp
              {...common}
              annotation={annotation}
              scale={scale}
              index={index}
              top={top(annotation.y + annotation.h, 0)}
            />
          );
        }

        if (annotation.kind === "signature") {
          const colour = rgb(annotation.color);
          return (
            <svg
              {...common}
              className="annot annot-signature"
              data-testid={`annot-${index}`}
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              style={{
                left: `${annotation.x * scale}px`,
                top: `${top(annotation.y + annotation.h, 0)}px`,
                width: `${annotation.w * scale}px`,
                height: `${annotation.h * scale}px`,
              }}
            >
              {annotation.strokes.map((points, n) => (
                <polyline
                  key={n}
                  points={points.map((point) => `${point.x},${1 - point.y}`).join(" ")}
                  fill="none"
                  stroke={colour}
                  strokeWidth={0.02}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          );
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

/**
 * A picture stamp before it is written into the document: an office seal or a
 * scanned signature, shown from its own bytes.
 *
 * The bytes are in memory rather than in a file, so the preview is a blob URL
 * of them — revoked when the mark goes, since a leaked one holds the picture
 * for the life of the page.
 */
function PictureStamp({
  annotation,
  scale,
  index,
  top,
  ...rest
}: {
  annotation: Extract<Annotation, { kind: "picture" }>;
  scale: number;
  index: number;
  top: number;
} & React.HTMLAttributes<HTMLImageElement>) {
  const src = useMemo(
    () =>
      URL.createObjectURL(
        new Blob([annotation.image as BlobPart], {
          type: annotation.format === "png" ? "image/png" : "image/jpeg",
        }),
      ),
    [annotation.image, annotation.format],
  );
  useEffect(() => () => URL.revokeObjectURL(src), [src]);

  return (
    <img
      {...rest}
      src={src}
      alt={annotation.label ?? "Picture stamp"}
      className="annot annot-picture"
      data-testid={`annot-${index}`}
      style={{
        left: `${annotation.x * scale}px`,
        top: `${top}px`,
        width: `${annotation.w * scale}px`,
        height: `${annotation.h * scale}px`,
      }}
    />
  );
}
