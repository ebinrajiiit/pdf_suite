import { useState } from "react";
import type { OutlineItem } from "@pdf-suite/engine";

export interface OutlineProps {
  items: OutlineItem[];
  /** Called with a source page index. */
  onGo: (page: number) => void;
}

/**
 * The document's bookmarks. Entries whose destination could not be resolved are
 * still shown, just not clickable: a broken link is no reason to hide a heading.
 */
export function Outline({ items, onGo }: OutlineProps) {
  if (items.length === 0) {
    return (
      <p className="outline-empty" data-testid="outline-empty">
        This document has no bookmarks.
      </p>
    );
  }
  return (
    <nav className="outline" data-testid="outline" aria-label="Bookmarks">
      <Branch items={items} onGo={onGo} depth={0} />
    </nav>
  );
}

function Branch({
  items,
  onGo,
  depth,
}: {
  items: OutlineItem[];
  onGo: (page: number) => void;
  depth: number;
}) {
  return (
    <ul className="outline-branch" style={{ paddingLeft: depth === 0 ? 0 : "0.75rem" }}>
      {items.map((item, index) => (
        <Entry key={`${depth}:${index}:${item.title}`} item={item} onGo={onGo} depth={depth} />
      ))}
    </ul>
  );
}

function Entry({
  item,
  onGo,
  depth,
}: {
  item: OutlineItem;
  onGo: (page: number) => void;
  depth: number;
}) {
  // Deep outlines start collapsed, or a 400-entry report fills the panel.
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = item.children.length > 0;

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
        {item.page === undefined ? (
          <span className="outline-title outline-dead" title="This bookmark has no destination">
            {item.title}
          </span>
        ) : (
          <button type="button" className="outline-title" onClick={() => onGo(item.page!)}>
            {item.title}
          </button>
        )}
      </div>
      {hasChildren && open ? <Branch items={item.children} onGo={onGo} depth={depth + 1} /> : null}
    </li>
  );
}
