/**
 * The display order is a list of source page indices in the positions the user
 * sees. Reordering and deleting only rewrite this list, so they cost nothing
 * until the document is saved — see packages/workers for how it is materialised.
 */

/** Moves the item at `from` so it lands at `to`. */
export function movePage(order: number[], from: number, to: number): number[] {
  if (from === to || from < 0 || from >= order.length || to < 0 || to >= order.length) return order;
  const next = [...order];
  const [page] = next.splice(from, 1);
  next.splice(to, 0, page!);
  return next;
}

/** Drops the given display positions. */
export function removePages(order: number[], positions: Iterable<number>): number[] {
  const drop = new Set(positions);
  return order.filter((_, position) => !drop.has(position));
}

/**
 * Puts `pages` (source indices) at `at`, or at the end when `at` is undefined.
 * Used after a merge: the appended pages exist in the document already and this
 * decides where they appear.
 */
export function insertPages(order: number[], pages: number[], at?: number): number[] {
  if (at === undefined || at >= order.length) return [...order, ...pages];
  const next = [...order];
  next.splice(Math.max(0, at), 0, ...pages);
  return next;
}

/** Source indices for the given display positions, in display order. */
export function pagesAt(order: number[], positions: Iterable<number>): number[] {
  const want = new Set(positions);
  return order.filter((_, position) => want.has(position));
}

/** True when the order is the identity of a document with `pageCount` pages. */
export function isIdentity(order: number[], pageCount: number): boolean {
  return order.length === pageCount && order.every((page, i) => page === i);
}
