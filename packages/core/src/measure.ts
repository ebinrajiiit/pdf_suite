import type { InkPoint } from "./annotate.js";

/**
 * Measuring on a drawing — Acrobat's distance, perimeter and area tools.
 *
 * A PDF of a site plan is drawn to a scale, and the question asked of it is
 * how long a wall is or how much floor there is. The geometry is simple; the
 * part worth being careful about is the scale, because a number without one is
 * a number of points, which is no use to anyone on site.
 */

export interface Scale {
  /** How many PDF points one unit of the drawing is. */
  pointsPerUnit: number;
  /** What that unit is called: m, ft, mm. */
  unit: string;
}

/** 72 points to the inch is the PDF's own definition, not a convention. */
export const SCALES: Record<string, Scale> = {
  points: { pointsPerUnit: 1, unit: "pt" },
  inches: { pointsPerUnit: 72, unit: "in" },
  cm: { pointsPerUnit: 72 / 2.54, unit: "cm" },
  mm: { pointsPerUnit: 72 / 25.4, unit: "mm" },
};

/** Straight-line distance between two points, in the scale's units. */
export function distance(a: InkPoint, b: InkPoint, scale: Scale): number {
  return Math.hypot(b.x - a.x, b.y - a.y) / scale.pointsPerUnit;
}

/** Length along a path, in the scale's units. `closed` adds the last leg. */
export function perimeter(points: InkPoint[], scale: Scale, closed = false): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1]!, points[i]!, scale);
  if (closed && points.length > 2) total += distance(points[points.length - 1]!, points[0]!, scale);
  return total;
}

/**
 * The area a closed path encloses, in square units.
 *
 * The shoelace formula, which is exact for any simple polygon — including the
 * concave ones a room with an alcove makes, where splitting into triangles by
 * eye goes wrong.
 */
export function area(points: InkPoint[], scale: Scale): number {
  if (points.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    twice += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twice / 2) / (scale.pointsPerUnit * scale.pointsPerUnit);
}

/** A measurement as it should read on the page. */
export function formatMeasurement(value: number, unit: string, square = false): string {
  const rounded =
    value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${rounded} ${unit}${square ? "²" : ""}`;
}
