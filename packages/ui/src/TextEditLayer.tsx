import { useEffect, useRef, useState } from "react";
import type { EditableText } from "@pdf-suite/engine/pdfium";

export interface TextEditLayerProps {
  /** Source page index. */
  page: number;
  /** Page height in PDF points, to flip the origin. */
  pageHeight: number;
  /** CSS pixels per PDF point. */
  scale: number;
  /** Blocks on this page, or undefined while they are still being read. */
  runs: EditableText[] | undefined;
  /** Called with the block and its new text when an edit is committed. */
  onCommit: (page: number, indices: number[], text: string) => void;
}

/**
 * Click a paragraph and type over it, as Acrobat's Edit PDF does.
 *
 * Each detected paragraph is a hit target the size of the block it covers,
 * outlined on hover so the block the editor thinks it found is visible before
 * anything is typed — paragraph detection is a guess (see the engine's
 * text-edit.ts) and a wrong one should be obvious, not surprising.
 *
 * Clicking swaps in a textarea positioned and sized to the block, so the text is
 * edited where it sits. The box shows the block's font size and colour but not
 * its typeface: the document's font lives inside the PDF and is not available to
 * CSS. The glyphs become the document's once the page re-renders; while typing
 * they are the system font at the right size, which is close enough to judge
 * length. Wrapping on commit is measured in the real font by the engine.
 */
export function TextEditLayer({ page, pageHeight, scale, runs, onCommit }: TextEditLayerProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  // A new page, or a reopened document, invalidates the block indices.
  useEffect(() => {
    setEditing(null);
  }, [runs]);

  useEffect(() => {
    if (editing !== null) input.current?.focus();
  }, [editing]);

  if (!runs) return <div className="editlayer editlayer-loading" data-testid={`edit-${page}`} />;

  /** PDF points from the bottom to CSS pixels from the top. */
  const top = (block: EditableText) => (pageHeight - block.y - block.h) * scale;
  /** Blocks are addressed by their first run, which is stable for these bytes. */
  const key = (block: EditableText) => block.indices[0] ?? -1;

  const commit = (block: EditableText) => {
    setEditing(null);
    if (draft.trim() !== block.text.trim()) onCommit(page, block.indices, draft.trim());
  };

  return (
    <div className="editlayer" data-testid={`edit-${page}`}>
      {runs.map((block) =>
        editing === key(block) ? (
          <textarea
            key={key(block)}
            ref={input}
            className="editbox"
            data-testid={`editbox-${key(block)}`}
            value={draft}
            spellCheck={false}
            style={{
              left: `${block.x * scale}px`,
              top: `${top(block)}px`,
              width: `${Math.max(block.w * scale, 60)}px`,
              height: `${Math.max(block.h * scale, block.fontSize * scale * 1.4)}px`,
              fontSize: `${block.fontSize * scale}px`,
              lineHeight: 1.2,
              color: `rgb(${block.colour.map((c) => Math.round(c * 255)).join(" ")})`,
            }}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commit(block)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(block);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(null);
              }
            }}
          />
        ) : (
          <button
            key={key(block)}
            type="button"
            className="edittarget"
            data-testid={`edittarget-${key(block)}`}
            title={
              `${block.indices.length > 1 ? `${block.indices.length} lines` : "1 line"}` +
              `${block.fontName ? `, ${block.fontName}` : ""} ` +
              `${block.fontSize.toFixed(0)}pt — click to edit, Enter to apply`
            }
            style={{
              left: `${block.x * scale}px`,
              top: `${top(block)}px`,
              width: `${Math.max(block.w * scale, 8)}px`,
              height: `${Math.max(block.h * scale, 10)}px`,
            }}
            onClick={() => {
              setDraft(block.text);
              setEditing(key(block));
            }}
          />
        ),
      )}
    </div>
  );
}
