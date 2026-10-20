import type { TextRun } from "@pdf-suite/engine";

export interface TextLayerProps {
  /** Source page index. */
  page: number;
  /** Page height in PDF points, to flip the origin. */
  pageHeight: number;
  /** CSS pixels per PDF point. */
  scale: number;
  /** Runs on this page, or undefined while they are still being read. */
  runs: TextRun[] | undefined;
}

/**
 * Invisible text over the rendered page, so the words can be selected and
 * copied.
 *
 * A page here is a canvas: pixels, with nothing for the browser to select. The
 * text is in the document and the engine already extracts it with positions —
 * search uses the same runs to place its highlights — so this lays each run out
 * as transparent text where its pixels are. Selecting, copying, triple-clicking
 * and the browser's own find all then work on real text, and the glyphs the
 * reader sees are still the document's own.
 *
 * Each run is scaled horizontally to the width the engine measured, because the
 * system font will not be the document's and the selection would otherwise drift
 * across a line. This is how pdf.js does it, for the same reason.
 */
export function TextLayer({ page, pageHeight, scale, runs }: TextLayerProps) {
  if (!runs) return <div className="textlayer" data-testid={`text-${page}`} />;

  return (
    <div className="textlayer" data-testid={`text-${page}`}>
      {runs.map((run, index) => (
        <span
          key={index}
          style={{
            left: `${run.x * scale}px`,
            top: `${(pageHeight - run.y - run.h) * scale}px`,
            // Line height 1 and a font size of the run's own height keep the
            // selection box the height of the text rather than of a CSS line.
            fontSize: `${Math.max(run.h * scale, 1)}px`,
            // The browser lays this out in its own font; stretching it to the
            // measured width is what keeps a selection in step with the glyphs.
            transform: `scaleX(${widthRatio(run, scale)})`,
          }}
        >
          {run.text}
        </span>
      ))}
    </div>
  );
}

/**
 * How much to stretch a run so it covers the width the engine measured. The
 * system font's own width is unknown here, so this uses a rough average
 * character width and lets the browser correct it; being a little off moves the
 * selection highlight, never the page itself.
 */
function widthRatio(run: TextRun, scale: number): number {
  const guess = run.text.length * run.h * scale * 0.5;
  if (guess <= 0) return 1;
  return Math.max(0.05, (run.w * scale) / guess);
}
