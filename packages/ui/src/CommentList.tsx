import { useMemo, useState } from "react";
import type { Annotation, ExistingAnnotation } from "@pdf-suite/core";

export interface CommentListProps {
  /** Pending annotations, in the order they were placed. */
  annotations: Annotation[];
  /** Marks the document already carried when it was opened. */
  existing?: ExistingAnnotation[] | undefined;
  /** Removes one of those, by page and index. */
  onRemoveExisting?: ((page: number, index: number) => void) | undefined;
  /** Answers one of those, or sets its review state. */
  onReply?: ((page: number, index: number, contents: string, state?: string) => void) | undefined;
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
export function CommentList({
  annotations,
  existing,
  positionOf,
  onGo,
  onRemove,
  onRemoveExisting,
  onReply,
}: CommentListProps) {
  /** Which mark is being answered, and what is being written. */
  const [answering, setAnswering] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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

  /**
   * The document's own marks as threads: a mark, then whatever answers it.
   * A reply and a status are both annotations pointing at their parent, so
   * neither belongs in the list as an entry of its own.
   */
  const theirs = useMemo(() => {
    const all = existing ?? [];
    const needle = query.trim().toLowerCase();
    const children = (parent: ExistingAnnotation) =>
      all.filter((mark) => mark.page === parent.page && mark.inReplyTo === parent.index);

    return all
      .filter((mark) => mark.inReplyTo === undefined)
      .filter((mark) => kind === "all" || mark.kind === EQUIVALENT[kind])
      .filter((mark) => {
        if (needle === "") return true;
        const thread = [mark, ...children(mark)]
          .map((one) => `${one.contents} ${one.author} ${one.kind}`)
          .join(" ");
        return thread.toLowerCase().includes(needle);
      })
      .sort((a, b) => (byPage ? positionOf(a.page) - positionOf(b.page) : 0))
      .map((mark) => {
        const replies = children(mark);
        return {
          mark,
          replies: replies.filter((reply) => reply.contents !== ""),
          // The latest state set on it wins, which is what a reviewer means by
          // changing their mind.
          state: replies.filter((reply) => reply.state).at(-1)?.state,
        };
      });
  }, [byPage, existing, kind, positionOf, query]);

  if (annotations.length === 0 && (existing?.length ?? 0) === 0) {
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
      {theirs.length > 0 ? (
        <ol className="comments" data-testid="comments-existing">
          {theirs.map(({ mark, replies, state }) => {
            const id = `${mark.page}-${mark.index}`;
            return (
              <li key={id} className="comment comment-theirs" data-testid={`mark-${id}`}>
                <div className="comment-head">
                  <span className="comment-kind">{mark.kind}</span>
                  <button
                    type="button"
                    className="comment-page"
                    onClick={() => onGo(mark.page)}
                    title={`Go to page ${positionOf(mark.page) + 1}`}
                  >
                    p{positionOf(mark.page) + 1}
                  </button>
                  {mark.author ? <span className="comment-author">{mark.author}</span> : null}
                  {state ? (
                    <span className="comment-state" data-testid={`state-${id}`}>
                      {state}
                    </span>
                  ) : null}
                  {onRemoveExisting ? (
                    <button
                      type="button"
                      className="comment-remove"
                      aria-label={`Remove the ${mark.kind} on page ${positionOf(mark.page) + 1}`}
                      data-testid={`remove-mark-${id}`}
                      onClick={() => onRemoveExisting(mark.page, mark.index)}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                {mark.contents ? <p className="comment-text">{mark.contents}</p> : null}

                {replies.map((reply) => (
                  <p
                    key={`${reply.page}:${reply.index}`}
                    className="comment-reply"
                    data-testid={`reply-${reply.page}-${reply.index}`}
                  >
                    {reply.author ? <span className="comment-author">{reply.author}</span> : null}
                    {reply.contents}
                  </p>
                ))}

                {onReply ? (
                  answering === id ? (
                    <form
                      className="comment-answer"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (draft.trim() === "") return;
                        onReply(mark.page, mark.index, draft.trim());
                        setDraft("");
                        setAnswering(null);
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="Your reply"
                        data-testid={`reply-input-${id}`}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                      <button type="submit" data-testid={`reply-send-${id}`}>
                        Reply
                      </button>
                    </form>
                  ) : (
                    <div className="comment-answer">
                      <button
                        type="button"
                        data-testid={`reply-${id}`}
                        onClick={() => {
                          setDraft("");
                          setAnswering(id);
                        }}
                      >
                        Reply
                      </button>
                      <select
                        aria-label="Review state"
                        data-testid={`set-state-${id}`}
                        value={state ?? "None"}
                        onChange={(event) => onReply(mark.page, mark.index, "", event.target.value)}
                      >
                        {["None", "Accepted", "Rejected", "Cancelled", "Completed"].map(
                          (option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                  )
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {shown.length === 0 && theirs.length === 0 ? (
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

/** Our kinds, as the PDF subtypes a document's own marks are read as. */
const EQUIVALENT: Record<string, string> = {
  highlight: "highlight",
  underline: "underline",
  strike: "strikeout",
  note: "text",
  text: "freetext",
  square: "square",
  circle: "circle",
  ink: "ink",
  line: "line",
  polygon: "polygon",
  polyline: "polyline",
  callout: "freetext",
  caret: "caret",
  stamp: "stamp",
  picture: "stamp",
  signature: "stamp",
};

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
  polygon: "Shape",
  polyline: "Path",
  callout: "Callout",
  caret: "Insert mark",
  stamp: "Stamp",
  picture: "Picture stamp",
  signature: "Signature",
};
