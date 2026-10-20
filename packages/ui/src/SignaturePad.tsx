import { useRef, useState } from "react";

export interface SignaturePadProps {
  /** Strokes in 0-1 of the box, y upwards as PDF measures it. */
  onSave: (strokes: { x: number; y: number }[][]) => void;
  onCancel: () => void;
}

const WIDTH = 480;
const HEIGHT = 160;

/**
 * Draw a signature once, with a mouse, a trackpad or a finger.
 *
 * Acrobat's Fill & Sign keeps a signature and places it on any document; this
 * is that, minus the account. The strokes are normalised to the box, so the
 * same signature can be placed at any size, and they never leave the device:
 * the caller keeps them in this browser's own storage.
 *
 * This is a drawn mark, not a digital signature. It proves nothing
 * cryptographically, which is exactly what a signature on a paper form proves,
 * and is a different feature from certificate-based signing.
 */
export function SignaturePad({ onSave, onCancel }: SignaturePadProps) {
  const [strokes, setStrokes] = useState<{ x: number; y: number }[][]>([]);
  const [drawing, setDrawing] = useState<{ x: number; y: number }[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const at = (event: React.PointerEvent) => {
    const rect = box.current?.getBoundingClientRect();
    return {
      x: (event.clientX - (rect?.left ?? 0)) / (rect?.width ?? WIDTH),
      // Upwards, so the strokes are in the same frame as the page they land on.
      y: 1 - (event.clientY - (rect?.top ?? 0)) / (rect?.height ?? HEIGHT),
    };
  };

  const all = drawing ? [...strokes, drawing] : strokes;

  return (
    <div className="signpad" data-testid="signature-pad">
      <div
        ref={box}
        className="signpad-box"
        data-testid="signature-canvas"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrawing([at(event)]);
        }}
        onPointerMove={(event) => {
          if (!drawing) return;
          const point = at(event);
          const last = drawing[drawing.length - 1];
          // A pen emits far more points than the shape needs, and every one
          // would end up in the PDF.
          if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.004) {
            setDrawing((current) => (current ? [...current, point] : current));
          }
        }}
        onPointerUp={() => {
          if (drawing && drawing.length > 1) setStrokes((current) => [...current, drawing]);
          setDrawing(null);
        }}
        onPointerCancel={() => setDrawing(null)}
      >
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          {all.map((stroke, index) => (
            <polyline
              key={index}
              points={stroke.map((point) => `${point.x},${1 - point.y}`).join(" ")}
              fill="none"
              stroke="currentColor"
              strokeWidth={0.006}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {all.length === 0 ? <span className="signpad-hint">Sign here</span> : null}
      </div>
      <div className="signpad-actions">
        <span className="hfnote">Kept on this device only. Not a digital signature.</span>
        <button
          type="button"
          className="action"
          data-testid="signature-clear"
          onClick={() => {
            setStrokes([]);
            setDrawing(null);
          }}
        >
          Clear
        </button>
        <button
          type="button"
          className="action action-go"
          data-testid="signature-save"
          disabled={strokes.length === 0}
          onClick={() => onSave(strokes)}
        >
          Use this signature
        </button>
        <button type="button" className="action" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
