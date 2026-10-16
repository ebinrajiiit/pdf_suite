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
 * ponytail: a flat list, not threads. Replies and a resolved state need `/IRT`
 * and `/RT` on the annotation plus a thread UI; this covers "what did I mark and
 * where" first, which is what makes a long document reviewable.
 */
export function CommentList({ annotations, positionOf, onGo, onRemove }: CommentListProps) {
  if (annotations.length === 0) {
    return (
      <p className="comments-empty" data-testid="comments-empty">
        No marks yet. Use Highlight, Note, Add text, or the shape tools; they are written into the
        file when you save.
      </p>
    );
  }

  return (
    <ol className="comments" data-testid="comments">
      {annotations.map((annotation, index) => {
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
};
