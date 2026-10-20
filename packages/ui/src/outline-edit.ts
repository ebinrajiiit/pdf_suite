import type { OutlineItem } from "@pdf-suite/engine";

/**
 * Editing a bookmark tree, as pure functions over it.
 *
 * A bookmark is addressed by its path — the index at each level down to it —
 * rather than by its title, because two headings in a long report will share a
 * title and the wrong one would move. Every function returns a new tree; none
 * of them changes what it was given.
 */

/** Renames the bookmark at `path`. */
export function renameAt(items: OutlineItem[], path: number[], title: string): OutlineItem[] {
  return mapAt(items, path, (item) => ({ ...item, title }));
}

/** Removes the bookmark at `path`, and whatever is under it. */
export function removeAt(items: OutlineItem[], path: number[]): OutlineItem[] {
  if (path.length === 0) return items;
  const [head, ...rest] = path as [number, ...number[]];
  if (rest.length === 0) return items.filter((_, index) => index !== head);
  return items.map((item, index) =>
    index === head ? { ...item, children: removeAt(item.children, rest) } : item,
  );
}

/** Moves the bookmark at `path` among its own siblings. */
export function moveAt(items: OutlineItem[], path: number[], by: -1 | 1): OutlineItem[] {
  if (path.length === 0) return items;
  const [head, ...rest] = path as [number, ...number[]];
  if (rest.length > 0) {
    return items.map((item, index) =>
      index === head ? { ...item, children: moveAt(item.children, rest, by) } : item,
    );
  }
  const to = head + by;
  if (to < 0 || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(head, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * Makes a bookmark a child of the one above it, as Tab does in an outliner.
 *
 * The first entry of a level has nothing to go under, so it stays where it is
 * rather than disappearing into a parent that is not there.
 */
export function indentAt(items: OutlineItem[], path: number[]): OutlineItem[] {
  if (path.length === 0) return items;
  const [head, ...rest] = path as [number, ...number[]];
  if (rest.length > 0) {
    return items.map((item, index) =>
      index === head ? { ...item, children: indentAt(item.children, rest) } : item,
    );
  }
  const previous = items[head - 1];
  const moving = items[head];
  if (!previous || !moving) return items;

  return items
    .map((item, index) =>
      index === head - 1 ? { ...item, children: [...item.children, moving] } : item,
    )
    .filter((_, index) => index !== head);
}

/** Moves a bookmark out to its parent's level, after the parent. */
export function outdentAt(items: OutlineItem[], path: number[]): OutlineItem[] {
  // Nothing at the top level has anywhere further out to go.
  if (path.length < 2) return items;

  const parentPath = path.slice(0, -1);
  const at = path[path.length - 1]!;

  const lift = (level: OutlineItem[], within: number[]): OutlineItem[] => {
    const [head, ...rest] = within as [number, ...number[]];
    if (rest.length > 0) {
      return level.map((item, index) =>
        index === head ? { ...item, children: lift(item.children, rest) } : item,
      );
    }
    const parent = level[head];
    const moving = parent?.children[at];
    if (!parent || !moving) return level;

    const next = [...level];
    next[head] = { ...parent, children: parent.children.filter((_, index) => index !== at) };
    next.splice(head + 1, 0, moving);
    return next;
  };

  return lift(items, parentPath);
}

/** Adds a bookmark at the end of the top level. */
export function addBookmark(items: OutlineItem[], title: string, page: number): OutlineItem[] {
  return [...items, { title, page, children: [] }];
}

function mapAt(
  items: OutlineItem[],
  path: number[],
  change: (item: OutlineItem) => OutlineItem,
): OutlineItem[] {
  if (path.length === 0) return items;
  const [head, ...rest] = path as [number, ...number[]];
  return items.map((item, index) => {
    if (index !== head) return item;
    return rest.length === 0
      ? change(item)
      : { ...item, children: mapAt(item.children, rest, change) };
  });
}
