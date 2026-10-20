import { useState } from "react";
import type { OutlineItem } from "@pdf-suite/engine";

export interface OutlineProps {
  items: OutlineItem[];
  /** Called with a source page index. */
  onGo: (page: number) => void;
  /** Editing, when the caller can write bookmarks back to the document. */
  onRename?: ((path: number[], title: string) => void) | undefined;
  onRemove?: ((path: number[]) => void) | undefined;
  onMove?: ((path: number[], by: -1 | 1) => void) | undefined;
  /** Nesting: in, under the entry above, or out to the parent's level. */
  onNest?: ((path: number[], direction: "in" | "out") => void) | undefined;
}

/**
 * The document's bookmarks. Entries whose destination could not be resolved are
 * still shown, just not clickable: a broken link is no reason to hide a heading.
 *
 * With the editing callbacks passed, each row also renames, removes and moves
 * within its own level. A bookmark is addressed by its path — the index at each
 * level down to it — so the caller never has to identify one by its title,
 * which two headings in a long report will happily share.
 */
export function Outline({ items, onGo, onRename, onRemove, onMove, onNest }: OutlineProps) {
  if (items.length === 0) {
    return (
      <p className="outline-empty" data-testid="outline-empty">
        This document has no bookmarks.
      </p>
    );
  }
  return (
    <nav className="outline" data-testid="outline" aria-label="Bookmarks">
      <Branch
        items={items}
        onGo={onGo}
        depth={0}
        path={[]}
        onRename={onRename}
        onRemove={onRemove}
        onMove={onMove}
        onNest={onNest}
      />
    </nav>
  );
}

interface BranchProps {
  items: OutlineItem[];
  onGo: (page: number) => void;
  depth: number;
  path: number[];
  onRename?: ((path: number[], title: string) => void) | undefined;
  onRemove?: ((path: number[]) => void) | undefined;
  onMove?: ((path: number[], by: -1 | 1) => void) | undefined;
  onNest?: ((path: number[], direction: "in" | "out") => void) | undefined;
}

function Branch({ items, onGo, depth, path, onRename, onRemove, onMove, onNest }: BranchProps) {
  return (
    <ul className="outline-branch" style={{ paddingLeft: depth === 0 ? 0 : "0.75rem" }}>
      {items.map((item, index) => (
        <Entry
          key={`${depth}:${index}:${item.title}`}
          item={item}
          onGo={onGo}
          depth={depth}
          path={[...path, index]}
          first={index === 0}
          last={index === items.length - 1}
          onRename={onRename}
          onRemove={onRemove}
          onMove={onMove}
          onNest={onNest}
        />
      ))}
    </ul>
  );
}

function Entry({
  item,
  onGo,
  depth,
  path,
  first,
  last,
  onRename,
  onRemove,
  onMove,
  onNest,
}: {
  item: OutlineItem;
  onGo: (page: number) => void;
  depth: number;
  path: number[];
  first: boolean;
  last: boolean;
  onRename?: ((path: number[], title: string) => void) | undefined;
  onRemove?: ((path: number[]) => void) | undefined;
  onMove?: ((path: number[], by: -1 | 1) => void) | undefined;
  onNest?: ((path: number[], direction: "in" | "out") => void) | undefined;
}) {
  // Deep outlines start collapsed, or a 400-entry report fills the panel.
  const [open, setOpen] = useState(depth < 1);
  const [renaming, setRenaming] = useState<string | null>(null);
  const hasChildren = item.children.length > 0;
  const id = path.join("-");

  return (
    <li className="outline-item">
      <div className="outline-row">
        {hasChildren ? (
          <button
            type="button"
            className="outline-twisty"
            aria-expanded={open}
            aria-label={open ? `Collapse ${item.title}` : `Expand ${item.title}`}
            onClick={() => setOpen(!open)}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="outline-twisty" aria-hidden="true" />
        )}
        {renaming !== null ? (
          <input
            className="outline-rename"
            data-testid={`bookmark-rename-${id}`}
            value={renaming}
            autoFocus
            onChange={(event) => setRenaming(event.target.value)}
            onBlur={() => {
              if (renaming.trim() !== "") onRename?.(path, renaming.trim());
              setRenaming(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              else if (event.key === "Escape") setRenaming(null);
            }}
          />
        ) : item.page === undefined ? (
          <span className="outline-title outline-dead" title="This bookmark has no destination">
            {item.title}
          </span>
        ) : (
          <button
            type="button"
            className="outline-title"
            data-testid={`bookmark-${id}`}
            onClick={() => onGo(item.page!)}
          >
            {item.title}
            <span className="outline-page">{item.page + 1}</span>
          </button>
        )}
        {onRename || onMove || onRemove || onNest ? (
          <span className="outline-actions">
            {onNest ? (
              <>
                <button
                  type="button"
                  aria-label={`Move ${item.title} out a level`}
                  data-testid={`bookmark-out-${id}`}
                  disabled={depth === 0}
                  onClick={() => onNest(path, "out")}
                >
                  ⇤
                </button>
                <button
                  type="button"
                  aria-label={`Move ${item.title} under the one above`}
                  data-testid={`bookmark-in-${id}`}
                  disabled={first}
                  onClick={() => onNest(path, "in")}
                >
                  ⇥
                </button>
              </>
            ) : null}
            {onMove ? (
              <>
                <button
                  type="button"
                  aria-label={`Move ${item.title} up`}
                  disabled={first}
                  onClick={() => onMove(path, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${item.title} down`}
                  disabled={last}
                  onClick={() => onMove(path, 1)}
                >
                  ↓
                </button>
              </>
            ) : null}
            {onRename ? (
              <button
                type="button"
                aria-label={`Rename ${item.title}`}
                data-testid={`bookmark-edit-${id}`}
                onClick={() => setRenaming(item.title)}
              >
                ✎
              </button>
            ) : null}
            {onRemove ? (
              <button
                type="button"
                aria-label={`Remove ${item.title}`}
                data-testid={`bookmark-remove-${id}`}
                onClick={() => onRemove(path)}
              >
                ✕
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {hasChildren && open ? (
        <Branch
          items={item.children}
          onGo={onGo}
          depth={depth + 1}
          path={path}
          onRename={onRename}
          onRemove={onRemove}
          onMove={onMove}
          onNest={onNest}
        />
      ) : null}
    </li>
  );
}
