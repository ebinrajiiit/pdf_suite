import { useEffect, useRef, useState } from "react";
import type { EditableText } from "@pdf-suite/engine/pdfium";

/** What a committed edit carries: the text, and the format if it was changed. */
export interface TextEditCommit {
  indices: number[];
  text: string;
  fontSize?: number | undefined;
  fontName?: string | undefined;
}

export interface TextEditLayerProps {
  /** Source page index. */
  page: number;
  /** Page height in PDF points, to flip the origin. */
  pageHeight: number;
  /** CSS pixels per PDF point. */
  scale: number;
  /** Blocks on this page, or undefined while they are still being read. */
  runs: EditableText[] | undefined;
  /** Called with the block and its new text and format when an edit is committed. */
  onCommit: (page: number, edit: TextEditCommit) => void;
}

/**
 * The faces a block can be changed to. The engine keeps the authoritative list
 * (`STANDARD_FONTS` in its text-edit.ts) and rejects anything else; this copy
 * exists so the UI bundle does not have to import the PDFium adapter for the
 * sake of nine strings. A test keeps the two in step.
 *
 * Each has a CSS stack so the editing box can at least show the right kind of
 * letterform while typing; the real glyphs arrive when the page re-renders.
 */
export const FACES: { name: string; label: string; css: string }[] = [
  { name: "Helvetica", label: "Helvetica", css: "Helvetica, Arial, sans-serif" },
  { name: "Helvetica-Bold", label: "Helvetica Bold", css: "Helvetica, Arial, sans-serif" },
  { name: "Helvetica-Oblique", label: "Helvetica Oblique", css: "Helvetica, Arial, sans-serif" },
  { name: "Times-Roman", label: "Times", css: "'Times New Roman', Times, serif" },
  { name: "Times-Bold", label: "Times Bold", css: "'Times New Roman', Times, serif" },
  { name: "Times-Italic", label: "Times Italic", css: "'Times New Roman', Times, serif" },
  { name: "Courier", label: "Courier", css: "'Courier New', Courier, monospace" },
  { name: "Courier-Bold", label: "Courier Bold", css: "'Courier New', Courier, monospace" },
  { name: "Courier-Oblique", label: "Courier Oblique", css: "'Courier New', Courier, monospace" },
];

/**
 * Click a paragraph and type over it, as Acrobat's Edit PDF does.
 *
 * Each detected paragraph is a hit target the size of the block it covers,
 * outlined on hover so the block the editor thinks it found is visible before
 * anything is typed — paragraph detection is a guess (see the engine's
 * text-edit.ts) and a wrong one should be obvious, not surprising.
 *
 * Clicking swaps in a textarea positioned and sized to the block, so the text is
 * edited where it sits, with a format bar above it: typeface, size, colour, line
 * count. The typeface the document uses is embedded in the PDF and not available
 * to CSS, so while typing the glyphs are the system font at the right size —
 * close enough to judge length. Wrapping is measured in the real font by the
 * engine on commit.
 *
 * Changing the face or the size from the bar rebuilds the block in that format,
 * which is why the choice is limited to the PDF standard fonts: those draw
 * everywhere without embedding anything, and a font this machine has is not a
 * font the next reader has.
 */
export function TextEditLayer({ page, pageHeight, scale, runs, onCommit }: TextEditLayerProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  /** Format chosen in the bar, or undefined to keep the document's own. */
  const [face, setFace] = useState<string | undefined>(undefined);
  const [size, setSize] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);

  // A new page, or a reopened document, invalidates the block indices.
  useEffect(() => {
    setEditing(null);
  }, [runs]);

  useEffect(() => {
    if (editing !== null) input.current?.focus();
  }, [editing]);

  if (!runs) return <div className="editlayer editlayer-loading" data-testid={`edit-${page}`} />;

  /** Embedded fonts carry a subset tag — "ABCDEF+Times" — which is noise here. */
  const faceOf = (block: EditableText) =>
    block.fontName.replace(/^[A-Z]{6}\+/, "") || "Embedded font";

  /** PDF points from the bottom to CSS pixels from the top. */
  const top = (block: EditableText) => (pageHeight - block.y - block.h) * scale;
  /** Blocks are addressed by their first run, which is stable for these bytes. */
  const key = (block: EditableText) => block.indices[0] ?? -1;
  /** The format bar sits above the block, or below it at the top of a page. */
  const barTop = (block: EditableText) =>
    top(block) >= 30 ? top(block) - 30 : top(block) + block.h * scale + 4;

  const open = (block: EditableText) => {
    setDraft(block.text);
    setFace(undefined);
    setSize(block.fontSize);
    setEditing(key(block));
  };

  const commit = (block: EditableText) => {
    setEditing(null);
    const sized = Math.round(size * 10) / 10;
    const changed =
      draft.trim() !== block.text.trim() ||
      face !== undefined ||
      Math.abs(sized - block.fontSize) > 0.05;
    if (!changed) return;
    onCommit(page, {
      indices: block.indices,
      text: draft.trim(),
      // Only send what changed: the engine reuses the existing runs when the
      // format is untouched, and rebuilds the block when it is not.
      fontSize: Math.abs(sized - block.fontSize) > 0.05 ? sized : undefined,
      fontName: face,
    });
  };

  return (
    <div className="editlayer" data-testid={`edit-${page}`}>
      {runs.map((block) =>
        editing === key(block) ? (
          <div
            key={key(block)}
            className="editgroup"
            // One blur handler for the whole group: clicking the face or size
            // control blurs the textarea, and that must not count as leaving.
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) commit(block);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                commit(block);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(null);
              }
            }}
          >
            {/* What Acrobat puts in its Format panel, over the text it applies
                to. The face and size are live: changing either rebuilds the
                block in that format. */}
            <div
              className="editbar"
              data-testid={`editbar-${key(block)}`}
              style={{ left: `${block.x * scale}px`, top: `${barTop(block)}px` }}
            >
              <span
                className="editbar-swatch"
                style={{
                  background: `rgb(${block.colour.map((c) => Math.round(c * 255)).join(" ")})`,
                }}
                title="The block's colour, which editing keeps"
              />
              <label className="editbar-field">
                <span className="sr-only">Font</span>
                <select
                  className="editbar-face"
                  data-testid={`editface-${key(block)}`}
                  value={face ?? ""}
                  onChange={(event) => setFace(event.target.value || undefined)}
                >
                  <option value="">{faceOf(block)} (keep)</option>
                  {FACES.map((option) => (
                    <option key={option.name} value={option.name}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="editbar-field">
                <span className="sr-only">Size in points</span>
                <input
                  className="editbar-size"
                  data-testid={`editsize-${key(block)}`}
                  type="number"
                  min={1}
                  max={400}
                  step={0.5}
                  value={size}
                  onChange={(event) => setSize(event.target.valueAsNumber || size)}
                />
              </label>
              <span className="editbar-unit">pt</span>
              <span className="editbar-lines">
                {block.indices.length === 1 ? "1 line" : `${block.indices.length} lines`}
              </span>
              <span className="editbar-keys">Enter to apply · Esc to cancel</span>
            </div>
            <textarea
              ref={input}
              className="editbox"
              data-testid={`editbox-${key(block)}`}
              value={draft}
              spellCheck={false}
              style={{
                left: `${block.x * scale}px`,
                top: `${top(block)}px`,
                width: `${Math.max(block.w * scale, 60)}px`,
                height: `${Math.max(block.h * scale, size * scale * 1.4)}px`,
                fontSize: `${size * scale}px`,
                fontFamily: FACES.find((option) => option.name === face)?.css,
                fontWeight: face?.includes("Bold") ? 700 : undefined,
                fontStyle: face?.match(/Italic|Oblique/) ? "italic" : undefined,
                lineHeight: 1.2,
                color: `rgb(${block.colour.map((c) => Math.round(c * 255)).join(" ")})`,
              }}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
        ) : (
          <button
            key={key(block)}
            type="button"
            className="edittarget"
            data-testid={`edittarget-${key(block)}`}
            title={
              `${faceOf(block)} ${block.fontSize.toFixed(0)}pt, ` +
              `${block.indices.length > 1 ? `${block.indices.length} lines` : "1 line"}` +
              " — click to edit"
            }
            style={{
              left: `${block.x * scale}px`,
              top: `${top(block)}px`,
              width: `${Math.max(block.w * scale, 8)}px`,
              height: `${Math.max(block.h * scale, 10)}px`,
            }}
            onClick={() => open(block)}
          />
        ),
      )}
    </div>
  );
}
