import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Index window to mount for a scrolling list of variably sized items.
 *
 * Offsets are cumulative, so `offsets[i]` is where item i starts and the last
 * entry is the total extent. Only the visible items plus `lookAhead` either side
 * are mounted, which is what keeps a 500-page document cheap
 * (docs/ARCHITECTURE.md).
 */
export function useVisibleRange(
  offsets: number[],
  lookAhead = 1,
): {
  ref: (node: HTMLElement | null) => void;
  range: { start: number; end: number };
  total: number;
  /** Scrolls the container, for jumping to a page. */
  scrollToOffset: (offset: number) => void;
} {
  const node = useRef<HTMLElement | null>(null);
  const [viewport, setViewport] = useState({ scroll: 0, size: 0 });
  const count = Math.max(0, offsets.length - 1);
  const total = offsets[count] ?? 0;

  const measure = useCallback(() => {
    const el = node.current;
    if (el) setViewport({ scroll: el.scrollTop, size: el.clientHeight });
  }, []);

  const ref = useCallback(
    (next: HTMLElement | null) => {
      node.current = next;
      measure();
    },
    [measure],
  );

  useEffect(() => {
    const el = node.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      // Coalesce to one measurement per frame; scroll fires far more often.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [measure]);

  const scrollToOffset = useCallback((offset: number) => {
    node.current?.scrollTo({ top: offset, behavior: "smooth" });
  }, []);

  return {
    ref,
    range: visibleRange(offsets, viewport.scroll, viewport.size, lookAhead),
    total,
    scrollToOffset,
  };
}

/**
 * The item window covering [scroll, scroll + size), widened by `lookAhead` on
 * each side. Pure, so the index arithmetic that decides whether a page is blank
 * can be tested without a DOM.
 */
export function visibleRange(
  offsets: number[],
  scroll: number,
  size: number,
  lookAhead = 1,
): { start: number; end: number } {
  const count = Math.max(0, offsets.length - 1);
  if (count === 0) return { start: 0, end: -1 };

  // A linear scan: page lists are short enough that a binary search would only
  // add code. ponytail: switch to a binary search if 10k-page documents appear.
  let start = 0;
  while (start < count - 1 && (offsets[start + 1] ?? 0) <= scroll) start++;
  let end = start;
  while (end < count - 1 && (offsets[end + 1] ?? 0) < scroll + size) end++;

  return { start: Math.max(0, start - lookAhead), end: Math.min(count - 1, end + lookAhead) };
}
