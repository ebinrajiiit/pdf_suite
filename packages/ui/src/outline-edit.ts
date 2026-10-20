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
