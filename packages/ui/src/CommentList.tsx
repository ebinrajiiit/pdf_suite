import { useMemo, useState } from "react";
import type { Annotation } from "@pdf-suite/core";

export interface CommentListProps {
  /** Pending annotations, in the order they were placed. */
  annotations: Annotation[];
  /** Maps a source page index to the display position, for the page label. */
  positionOf: (page: number) => number;
  onGo: (page: number) => void;
  onRemove: (index: number) => void;
}

/**
 * Every mark on the document in one list, so a reader can work through them
 * instead of hunting the pages.
 *
 * Filtering by kind, searching the text and sorting by page are what make a
 * list of two hundred marks usable; Acrobat's comment pane has all three.
 *
 * ponytail: still a flat list, not threads. Replies and a resolved state need
 * `/IRT` and `/RT` on the annotation plus a thread UI.
 */
export function CommentList({ annotations, positionOf, onGo, onRemove }: CommentListProps) {
  const [kind, setKind] = useState<"all" | Annotation["kind"]>("all");
  const [query, setQuery] = useState("");
  const [byPage, setByPage] = useState(true);

  /** The list as shown, each keeping the index it has in the document. */
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = annotations
      .map((annotation, index) => ({ annotation, index }))
      .filter((row) => kind === "all" || row.annotation.kind === kind)
      .filter((row) => {
        if (needle === "") return true;
        const text = "contents" in row.annotation ? row.annotation.contents : "";
        const label = "label" in row.annotation ? row.annotation.label : "";
        return `${text} ${label} ${LABELS[row.annotation.kind]}`.toLowerCase().includes(needle);
      });
    return byPage
      ? [...rows].sort(
          (a, b) =>
            positionOf(a.annotation.page) - positionOf(b.annotation.page) || a.index - b.index,
        )
      : rows;
  }, [annotations, byPage, kind, positionOf, query]);

  if (annotations.length === 0) {
    return (
      <p className="comments-empty" data-testid="comments-empty">
        No marks yet. Use Highlight, Note, Add text, or the shape tools; they are written into the
        file when you save.
      </p>
    );
  }

  return (
    <>
      <div className="comment-filters">
        <input
          type="search"
          className="comment-search"
          aria-label="Search the marks"
          placeholder="Search marks"
          data-testid="comment-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Kind of mark"
          data-testid="comment-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          <option value="all">All kinds</option>
          {[...new Set(annotations.map((annotation) => annotation.kind))].map((one) => (
            <option key={one} value={one}>
              {LABELS[one]}
            </option>
          ))}
        </select>
        <label className="comment-sort">
          <input
            type="checkbox"
            data-testid="comment-by-page"
            checked={byPage}
            onChange={(event) => setByPage(event.target.checked)}
          />
          By page
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="comments-empty" data-testid="comments-none">
          No mark matches that.
        </p>
      ) : null}
      <ol className="comments" data-testid="comments">
        {shown.map(({ annotation, index }) => {
          const position = positionOf(annotation.page);
          return (
            <li key={index} className="comment" data-testid={`comment-${index}`}>
              <div className="comment-head">
                <span className={`comment-kind comment-kind-${annotation.kind}`}>
                  {LABELS[annotation.kind]}
                </span>
                <button
                  type="button"
                  className="comment-page"
                  onClick={() => onGo(annotation.page)}
                  title={`Go to page ${position + 1}`}
                >
                  p{position + 1}
                </button>
                <button
                  type="button"
                  className="comment-remove"
                  aria-label={`Remove ${LABELS[annotation.kind]} on page ${position + 1}`}
                  onClick={() => onRemove(index)}
                >
                  ×
                </button>
              </div>
              {"contents" in annotation && annotation.contents !== "" ? (
                <p className="comment-text">{annotation.contents}</p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}

const LABELS: Record<Annotation["kind"], string> = {
  highlight: "Highlight",
  underline: "Underline",
  strike: "Strike-through",
  note: "Note",
  text: "Text",
  square: "Box",
  circle: "Oval",
  ink: "Freehand",
  line: "Line",
  stamp: "Stamp",
  signature: "Signature",
};
