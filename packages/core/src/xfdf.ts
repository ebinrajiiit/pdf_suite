import type { Annotation, AnnotRect } from "./annotate.js";
import type { ExistingAnnotation } from "./read-annots.js";

/**
 * XFDF: comments as a file of their own.
 *
 * This is how a review happens without a server. One person marks up the
 * document, exports the marks, sends the small XML file, and the other imports
 * it into their copy. Acrobat has done it this way for twenty years, and it is
 * the one review workflow that does not need anything of ours in the middle —
 * which is the point of this product.
 *
 * The XML is written and read by hand rather than with a parser. A worker has
 * no DOMParser, the subset involved is small and fixed, and a dependency that
 * parses arbitrary XML is a larger attack surface than the feature is worth.
 * What this accepts is what Acrobat and this app emit; anything else is
 * skipped rather than guessed at, and the caller is told how many were skipped.
 */

export interface XfdfMark {
  /** Source page index. */
  page: number;
  /** The XFDF element name: highlight, text, square, circle, ink, freetext… */
  kind: string;
  /** Box in PDF points, origin at the page's bottom-left. */
  rect: AnnotRect;
  contents: string;
  author: string;
  colour?: [number, number, number] | undefined;
  /** Quads for text markup, flattened as the format writes them. */
  coords?: number[] | undefined;
  /** Ink paths, each a flat list of x y pairs. */
  paths?: number[][] | undefined;
}

export interface XfdfImport {
  marks: XfdfMark[];
  /** Elements recognised as marks but not understood well enough to place. */
  skipped: number;
}

/** XML text, with the five characters that would otherwise end it escaped. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

const COLOUR = (colour?: [number, number, number]): string => {
  if (!colour) return "";
  const hex = colour
    .map((part) =>
      Math.round(Math.max(0, Math.min(1, part)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
  return ` color="#${hex}"`;
};

/** The XFDF element name for one of our own marks. */
function elementFor(kind: Annotation["kind"]): string {
  switch (kind) {
    case "note":
      return "text";
    case "strike":
      return "strikeout";
    case "text":
    case "callout":
      return "freetext";
    case "signature":
      return "stamp";
    default:
      return kind;
  }
}

/** Writes marks as an XFDF file, with the document they belong to named. */
export function toXfdf(
  marks: (ExistingAnnotation | { annotation: Annotation; rect: AnnotRect })[],
  documentName = "",
): string {
  const rows: string[] = [];

  for (const mark of marks) {
    const existing = "kind" in mark ? mark : undefined;
    const placed = existing ? undefined : (mark as { annotation: Annotation; rect: AnnotRect });
    const kind = existing ? existing.kind : elementFor(placed!.annotation.kind);
    const rect = existing
      ? { x: existing.x, y: existing.y, w: existing.w, h: existing.h }
      : placed!.rect;
    const contents = existing ? existing.contents : contentsOf(placed!.annotation);
    const author = existing ? existing.author : (placed!.annotation.author ?? "");
    const colour = existing ? existing.colour : placed!.annotation.color;

    rows.push(
      `<${kind} page="${existing ? existing.page : placed!.annotation.page}" ` +
        `rect="${[rect.x, rect.y, rect.x + rect.w, rect.y + rect.h].map(round).join(",")}"` +
        COLOUR(colour) +
        (author ? ` title="${escapeXml(author)}"` : "") +
        (existing?.state ? ` state="${escapeXml(existing.state)}"` : "") +
        `>` +
        (contents ? `<contents>${escapeXml(contents)}</contents>` : "") +
        `</${kind}>`,
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n` +
    `<annots>\n${rows.join("\n")}\n</annots>\n` +
    (documentName ? `<f href="${escapeXml(documentName)}"/>\n` : "") +
    `</xfdf>\n`
  );
}

function contentsOf(annotation: Annotation): string {
  return "contents" in annotation
    ? annotation.contents
    : "label" in annotation
      ? annotation.label
      : "";
}

function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/** The marks in an XFDF file. */
export function fromXfdf(xml: string): XfdfImport {
  const marks: XfdfMark[] = [];
  let skipped = 0;

  // Each annotation is one element; the subset here is flat, so a tag scan is
  // enough and no tree has to be built.
  const elements = xml.matchAll(
    /<(highlight|underline|strikeout|squiggly|text|square|circle|line|polygon|polyline|ink|freetext|stamp|caret)\b([^>]*)(\/>|>([\s\S]*?)<\/\1>)/g,
  );

  for (const element of elements) {
    const [, kind = "", attributes = "", , body = ""] = element;
    const page = Number(attribute(attributes, "page") ?? "");
    const rect = (attribute(attributes, "rect") ?? "").split(",").map(Number);
    if (!Number.isInteger(page) || page < 0 || rect.length !== 4 || rect.some(Number.isNaN)) {
      skipped++;
      continue;
    }

    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = rect;
    const coords = (attribute(attributes, "coords") ?? "")
      .split(/[,\s]+/)
      .map(Number)
      .filter((value) => !Number.isNaN(value));
    const paths = [...body.matchAll(/<gesture>([^<]*)<\/gesture>/g)].map((gesture) =>
      (gesture[1] ?? "")
        .split(/[,\s]+/)
        .map(Number)
        .filter((value) => !Number.isNaN(value)),
    );

    marks.push({
      page,
      kind,
      rect: {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1),
      },
      contents: unescapeXml(/<contents>([\s\S]*?)<\/contents>/.exec(body)?.[1] ?? ""),
      author: unescapeXml(attribute(attributes, "title") ?? ""),
      ...(colourFrom(attribute(attributes, "color"))
        ? { colour: colourFrom(attribute(attributes, "color")) }
        : {}),
      ...(coords.length >= 8 ? { coords } : {}),
      ...(paths.length > 0 ? { paths } : {}),
    });
  }

  return { marks, skipped };
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1];
}

function colourFrom(value?: string): [number, number, number] | undefined {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
  return [
    parseInt(value.slice(1, 3), 16) / 255,
    parseInt(value.slice(3, 5), 16) / 255,
    parseInt(value.slice(5, 7), 16) / 255,
  ];
}

/**
 * Turns imported marks into annotations this app can write.
 *
 * What cannot be represented is dropped rather than approximated: a squiggly
 * underline becomes nothing, not a straight one, because a mark that says
 * something slightly different from what the reviewer wrote is worse than a
 * mark that is missing and counted.
 */
export function asAnnotations(marks: XfdfMark[]): { annotations: Annotation[]; dropped: number } {
  const annotations: Annotation[] = [];
  let dropped = 0;

  for (const mark of marks) {
    const { page, rect, contents, author, colour } = mark;
    const common = { page, ...(author ? { author } : {}), ...(colour ? { color: colour } : {}) };

    switch (mark.kind) {
      case "highlight":
      case "underline":
      case "strikeout": {
        const kind = mark.kind === "strikeout" ? "strike" : mark.kind;
        // Quads where the file has them, the box where it does not.
        const rects: AnnotRect[] = mark.coords ? quadsToRects(mark.coords) : [rect];
        annotations.push({ ...common, kind, rects });
        break;
      }
      case "text":
        annotations.push({ ...common, kind: "note", x: rect.x, y: rect.y + rect.h, contents });
        break;
      case "square":
        annotations.push({ ...common, kind: "square", ...rect });
        break;
      case "circle":
        annotations.push({ ...common, kind: "circle", ...rect });
        break;
      case "freetext":
        annotations.push({
          ...common,
          kind: "text",
          x: rect.x,
          y: rect.y + rect.h,
          w: rect.w,
          h: rect.h,
          contents,
        });
        break;
      case "ink": {
        const strokes = (mark.paths ?? []).map((path) => {
          const points: { x: number; y: number }[] = [];
          for (let i = 0; i + 1 < path.length; i += 2)
            points.push({ x: path[i]!, y: path[i + 1]! });
          return points;
        });
        if (strokes.every((stroke) => stroke.length === 0)) {
          dropped++;
          break;
        }
        annotations.push({ ...common, kind: "ink", strokes });
        break;
      }
      default:
        dropped++;
    }
  }

  return { annotations, dropped };
}

/** XFDF quads are x1 y1 x2 y2 x3 y3 x4 y4 per line, corners clockwise from top-left. */
function quadsToRects(coords: number[]): AnnotRect[] {
  const rects: AnnotRect[] = [];
  for (let i = 0; i + 7 < coords.length; i += 8) {
    const xs = [coords[i]!, coords[i + 2]!, coords[i + 4]!, coords[i + 6]!];
    const ys = [coords[i + 1]!, coords[i + 3]!, coords[i + 5]!, coords[i + 7]!];
    rects.push({
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    });
  }
  return rects;
}
