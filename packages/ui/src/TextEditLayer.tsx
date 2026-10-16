import { useEffect, useRef, useState } from "react";
import type { EditableText } from "@pdf-suite/engine/pdfium";

export interface TextEditLayerProps {
  /** Source page index. */
  page: number;
  /** Page height in PDF points, to flip the origin. */
  pageHeight: number;
  /** CSS pixels per PDF point. */
  scale: number;
  /** Runs on this page, or undefined while they are still being read. */
  runs: EditableText[] | undefined;
  /** Called with the run and its new text when an edit is committed. */
  onCommit: (page: number, index: number, text: string) => void;
}

/**
 * Click a line of text and type over it, as Acrobat's Edit PDF does.
 *
 * Each run is a hit target the size of the text it covers. Clicking one swaps in
 * an input positioned and sized to match, so the text appears to be edited
 * where it sits rather than in a dialogue somewhere else.
 *
 * The input shows the run's own font size and colour, but not its typeface: the
 * document's font is embedded in the PDF and is not available to CSS. The glyphs
 * will be the document's once it re-renders; while typing they are the system
 * font at the right size, which is close enough to judge length and position.
 */
export function TextEditLayer({ page, pageHeight, scale, runs, onCommit }: TextEditLayerProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // A new page, or a reopened document, invalidates the run indices.
  useEffect(() => {
    setEditing(null);
  }, [runs]);

  useEffect(() => {
    if (editing !== null) input.current?.focus();
  }, [editing]);

  if (!runs) return <div className="editlayer editlayer-loading" data-testid={`edit-${page}`} />;

  /** PDF points from the bottom to CSS pixels from the top. */
  const top = (run: EditableText) => (pageHeight - run.y - run.h) * scale;

  const commit = (run: EditableText) => {
    setEditing(null);
    if (draft !== run.text) onCommit(page, run.index, draft);
  };

  return (
    <div className="editlayer" data-testid={`edit-${page}`}>
      {runs.map((run) =>
        editing === run.index ? (
          <input
            key={run.index}
            ref={input}
            className="editbox"
            data-testid={`editbox-${run.index}`}
            value={draft}
            style={{
              left: `${run.x * scale}px`,
              top: `${top(run)}px`,
              width: `${Math.max(run.w * scale + 40, 60)}px`,
              height: `${Math.max(run.h * scale, 14)}px`,
              fontSize: `${run.fontSize * scale}px`,
              color: `rgb(${run.colour.map((c) => Math.round(c * 255)).join(" ")})`,
            }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commit(run)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(run);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(null);
              }
            }}
          />
        ) : (
          <button
            key={run.index}
            type="button"
            className="edittarget"
            data-testid={`edittarget-${run.index}`}
            title={run.fontName ? `${run.fontName} ${run.fontSize.toFixed(0)}pt` : "Edit this text"}
            style={{
              left: `${run.x * scale}px`,
              top: `${top(run)}px`,
              width: `${Math.max(run.w * scale, 8)}px`,
              height: `${Math.max(run.h * scale, 10)}px`,
            }}
            onClick={() => {
              setDraft(run.text);
              setEditing(run.index);
            }}
          />
        ),
      )}
    </div>
  );
}
