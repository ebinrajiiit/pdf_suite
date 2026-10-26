import { useRef, useState } from "react";

/**
 * A signature kept on this device. Drawn or typed — the two Acrobat Reader's
 * Fill & Sign offers that need storing. Its third, a photo or scan of a real
 * signature, is a picture and goes through the picture tool instead.
 */
export type SavedSignature =
  /** Strokes in 0-1 of the box, y upwards as PDF measures it. */
  { kind: "drawn"; strokes: { x: number; y: number }[][] } | { kind: "typed"; name: string };

export interface SignaturePadProps {
  onSave: (signature: SavedSignature) => void;
  onCancel: () => void;
  /** Offered beside drawing and typing, when the caller can place a picture. */
  onUsePicture?: (() => void) | undefined;
  /** What the name box starts with, so a signature can be corrected. */
  name?: string | undefined;
}

const WIDTH = 480;
const HEIGHT = 160;

/**
 * Make a signature once: draw it with a mouse, a trackpad or a finger, or type
 * your name and have it set in Times Italic.
 *
 * Acrobat's Fill & Sign keeps a signature and places it on any document; this
 * is that, minus the account. A drawn signature is normalised to its box, so it
 * can be placed at any size, and neither kind leaves the device: the caller
 * keeps it in this browser's own storage.
 *
 * This is a mark on the page, not a digital signature. It proves nothing
 * cryptographically, which is exactly what a signature on a paper form proves,
 * and is a different feature from certificate-based signing (ADR 0006).
 */
export function SignaturePad({
  onSave,
  onCancel,
  onUsePicture,
  name: initialName,
}: SignaturePadProps) {
  const [strokes, setStrokes] = useState<{ x: number; y: number }[][]>([]);
  const [drawing, setDrawing] = useState<{ x: number; y: number }[] | null>(null);
  /**
   * Typing is not a lesser option: drawing a signature with a mouse is most of
   * why people give up on signing a PDF, and on a desktop there is no finger.
   */
  const [how, setHow] = useState<"draw" | "type">(initialName ? "type" : "draw");
  const [name, setName] = useState(initialName ?? "");
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

  const typed = name.trim();

  return (
    <div className="signpad" data-testid="signature-pad">
      <div className="signpad-ways" role="group" aria-label="How to sign">
        <button
          type="button"
          className={how === "draw" ? "action action-on" : "action"}
          aria-pressed={how === "draw"}
          data-testid="sign-draw"
          onClick={() => setHow("draw")}
        >
          Draw it
        </button>
        <button
          type="button"
          className={how === "type" ? "action action-on" : "action"}
          aria-pressed={how === "type"}
          data-testid="sign-type"
          onClick={() => setHow("type")}
        >
          Type it
        </button>
        {onUsePicture ? (
          <button
            type="button"
            className="action"
            data-testid="sign-picture"
            title="A photo or scan of your real signature"
            onClick={onUsePicture}
          >
            Use a picture…
          </button>
        ) : null}
      </div>

      {how === "type" ? (
        <>
          <label className="signpad-name">
            <span className="hfnote">Your name, as you sign it</span>
            <input
              autoFocus
              data-testid="signature-name"
              value={name}
              placeholder="A. R. Nair"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="signpad-box signpad-typed" data-testid="signature-typed">
            {typed === "" ? <span className="signpad-hint">Type your name above</span> : typed}
          </div>
        </>
      ) : (
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
      )}
      <div className="signpad-actions">
        <span className="hfnote">Kept on this device only. Not a digital signature.</span>
        <button
          type="button"
          className="action"
          data-testid="signature-clear"
          onClick={() => {
            if (how === "type") {
              setName("");
              return;
            }
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
          disabled={how === "type" ? typed === "" : strokes.length === 0}
          onClick={() =>
            onSave(how === "type" ? { kind: "typed", name: typed } : { kind: "drawn", strokes })
          }
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
