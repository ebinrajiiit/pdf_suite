import { expect, test } from "vitest";
import { area, distance, formatMeasurement, perimeter, SCALES } from "./measure.js";

const square = [
  { x: 0, y: 0 },
  { x: 72, y: 0 },
  { x: 72, y: 72 },
  { x: 0, y: 72 },
];

test("an inch is seventy-two points, which is the PDF's own definition", () => {
  expect(distance({ x: 0, y: 0 }, { x: 72, y: 0 }, SCALES.inches!)).toBeCloseTo(1, 6);
  expect(distance({ x: 0, y: 0 }, { x: 72, y: 0 }, SCALES.cm!)).toBeCloseTo(2.54, 4);
  expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 }, SCALES.points!)).toBe(5);
});

test("perimeter runs along the path, and closes it when asked", () => {
  expect(perimeter(square, SCALES.inches!)).toBeCloseTo(3, 6);
  expect(perimeter(square, SCALES.inches!, true)).toBeCloseTo(4, 6);
});

test("area is exact on a concave shape, where eyeballing triangles is not", () => {
  expect(area(square, SCALES.inches!)).toBeCloseTo(1, 6);

  // An L: a two-inch square with a one-inch bite out of it, so three square
  // inches.
  const ell = [
    { x: 0, y: 0 },
    { x: 144, y: 0 },
    { x: 144, y: 72 },
    { x: 72, y: 72 },
    { x: 72, y: 144 },
    { x: 0, y: 144 },
  ];
  expect(area(ell, SCALES.inches!)).toBeCloseTo(3, 6);
});

test("a path that is not a shape has no area", () => {
  expect(area([{ x: 0, y: 0 }], SCALES.inches!)).toBe(0);
  expect(
    area(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      SCALES.inches!,
    ),
  ).toBe(0);
});

test("the number is written the way a drawing is read", () => {
  expect(formatMeasurement(1.2345, "m")).toBe("1.23 m");
  expect(formatMeasurement(12.345, "m")).toBe("12.3 m");
  expect(formatMeasurement(1234.5, "m")).toBe("1235 m");
  expect(formatMeasurement(2.5, "m", true)).toBe("2.50 m²");
});

test("a scale is a scale: ten points to the metre makes a long wall", () => {
  const drawing = { pointsPerUnit: 10, unit: "m" };
  expect(distance({ x: 0, y: 0 }, { x: 500, y: 0 }, drawing)).toBe(50);
  expect(area(square, drawing)).toBeCloseTo(51.84, 2);
});
