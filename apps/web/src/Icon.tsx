/**
 * The icon set.
 *
 * These were Unicode glyphs — "U̲", "S̶", "▭̲", "📎", "✿". Three problems with
 * that: a combining underline or strike renders differently (or broken) on every
 * platform, an emoji arrives in full colour among monochrome marks, and a text
 * character has no consistent optical size, so a row of tools came out ragged.
 *
 * Drawn here instead, inline: one grid, one stroke weight, and `currentColor`,
 * so a tool that is on, off or disabled takes the colour of its button with no
 * second rule. Inline because the CSP forbids a sprite from another origin and
 * an <img> per icon would be a request each.
 */

/** 24×24, 1.75 stroke, round joins — the shape only, drawn in currentColor. */
const PATHS = {
  // ---- file and document ----
  open: "M3 7a1 1 0 011-1h5l2 2h9a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1z",
  save: "M5 4h10l4 4v12H5zM9 4v5h6M8 14h8v6H8z",
  print:
    "M7 9V4h10v5M7 17H5a1 1 0 01-1-1v-5a1 1 0 011-1h14a1 1 0 011 1v5a1 1 0 01-1 1h-2M8 15h8v5H8z",
  merge: "M7 3v6l5 5v6M17 3v6l-4 4",
  batch: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
  panel: "M3 5h18v14H3zM15 5v14",
  command: "M4 6h16M4 12h16M4 18h10",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14M20 20l-4.3-4.3",
  undo: "M4 10h11a5 5 0 010 10h-5M4 10l4-4M4 10l4 4",
  rotateleft: "M4 8h7M4 8V3M4 8a9 9 0 1 1 0 8",
  rotateright: "M20 8h-7M20 8V3M20 8a9 9 0 1 0 0 8",
  redo: "M20 10H9a5 5 0 000 10h5M20 10l-4-4M20 10l-4 4",

  // ---- marking up ----
  highlight: "M15 3l6 6-8 8H7v-6zM3 21h18",
  underline: "M7 4v6a5 5 0 0010 0V4M5 20h14",
  strike: "M4 12h16M8 6h8M8 18h8",
  note: "M5 4h10l4 4v12H5zM15 4v4h4M9 13h6M9 16h4",
  text: "M5 6V4h14v2M12 4v16M9 20h6",
  square: "M4 5h16v14H4z",
  circle: "M12 4a8 8 0 100 16 8 8 0 000-16z",
  ink: "M3 17c3-7 6 6 9-1s6-5 9-1",
  crop: "M6 2v16h16M2 6h16v16",
  field: "M3 7h18v10H3zM8 10v4M7 10h2M7 14h2",
  link: "M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1",
  line: "M5 19L19 5",
  arrow: "M5 19L19 5M13 5h6v6",
  polygon: "M12 3l9 7-3.5 11h-11L3 10z",
  cloud: "M7 18a4 4 0 01-.5-8 5.5 5.5 0 0110.4-1.4A4 4 0 0117 18z",
  measure: "M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3",
  measurearea: "M4 5h16v14H4zM4 19L20 5",
  polyline: "M3 16l5-6 4 4 4-7 5 5",
  callout: "M4 5h16v10h-9l-4 4v-4H4zM8 10h8",
  caret: "M6 18l6-11 6 11M9 14h6",
  stamp: "M8 10a4 4 0 118 0c0 2.5-1.5 3-1.5 5h-5C9.5 13 8 12.5 8 10zM5 19h14v2H5z",
  signature: "M3 17c3.5 0 4.5-9 7-9s1.5 6 4 6 3-2.5 4.5-3.5M3 21h18",
  picture: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M9 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z",
  attachment:
    "M15 8l-6.5 6.5a2.5 2.5 0 003.5 3.5L20 10a4.5 4.5 0 00-6.5-6.5L5.5 11.5a6.5 6.5 0 009 9L21 14",
  redact: "M4 8h16v8H4z",

  // ---- viewing ----
  zoomin: "M11 4a7 7 0 100 14 7 7 0 000-14M20 20l-4.3-4.3M8 11h6M11 8v6",
  zoomout: "M11 4a7 7 0 100 14 7 7 0 000-14M20 20l-4.3-4.3M8 11h6",
  fit: "M4 5v14M20 5v14M7 12h10M7 12l2.5-2.5M7 12l2.5 2.5M17 12l-2.5-2.5M17 12l-2.5 2.5",
  page: "M5 4h14v16H5zM12 8v8M12 8l-2 2M12 8l2 2M12 16l-2-2M12 16l2-2",
  single: "M8 3h8v18H8z",
  twoup: "M3 4h8v16H3zM13 4h8v16h-8z",
  fullscreen: "M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5",
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
} as const;

export type IconName = keyof typeof PATHS;

/** Filled, not stroked: these read as a solid mark rather than an outline. */
const FILLED = new Set<IconName>(["redact", "note"]);

export function Icon({ name, className }: { name: IconName; className?: string | undefined }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative: every button that carries one also carries its own text or
      // an aria-label, so announcing the icon would repeat it.
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} {...(FILLED.has(name) ? { fill: "currentColor" } : {})} />
    </svg>
  );
}
