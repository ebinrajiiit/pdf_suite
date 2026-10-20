import { PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import type { PdfBytes } from "./ops.js";

/**
 * Checking whether a document can be read by someone who is not reading it with
 * their eyes — Acrobat's Accessibility Check, and the parts of its "Make
 * Accessible" action that can be done without inventing a document's structure.
 *
 * For a public university this is not a nicety: a published document that a
 * screen reader cannot announce is one a blind student cannot use. The checks
 * here are the ones with an unambiguous answer — a missing title, a missing
 * language, an untagged file — rather than the judgement calls, which a tool
 * cannot make honestly.
 *
 * What is deliberately not here: generating the tag tree. Tagging a document
 * means deciding what is a heading, what is a table, and in what order it
 * should be read, from nothing but coordinates. Acrobat guesses, and its guess
 * is wrong often enough that its own help tells you to check every tag
 * afterwards. Claiming to have done it would be worse than saying it is not
 * done.
 */

export interface AccessibilityIssue {
  id: "title" | "language" | "tagged" | "displayTitle" | "scanned" | "alt";
  /** A fail blocks a reader; a warning degrades the experience. */
  severity: "fail" | "warn";
  summary: string;
  /** What it means for a reader, which is the part that justifies the work. */
  detail: string;
  /** True when `fixAccessibility` can put it right without guessing. */
  fixable: boolean;
}

export interface CheckOptions {
  /**
   * Display positions with no text layer. The caller knows this — it has the
   * engine — and a scanned page without OCR is the single worst accessibility
   * failure a document can have.
   */
  pagesWithoutText?: number[];
  /** How many images the document has, for the alternate-text check. */
  imageCount?: number;
}

export async function checkAccessibility(
  input: PdfBytes,
  options: CheckOptions = {},
): Promise<AccessibilityIssue[]> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const catalog = doc.catalog;
  const issues: AccessibilityIssue[] = [];

  if ((doc.getTitle() ?? "").trim() === "") {
    issues.push({
      id: "title",
      severity: "fail",
      summary: "No title",
      detail:
        "A screen reader announces the file name instead, which is usually something " +
        "like final(2).pdf.",
      fixable: true,
    });
  }

  const lang = catalog.get(PDFName.of("Lang"));
  if (!(lang instanceof PDFString) || lang.asString().trim() === "") {
    issues.push({
      id: "language",
      severity: "fail",
      summary: "No language set",
      detail:
        "Without a language a screen reader guesses the pronunciation, and reads " +
        "English with the voice it has set for something else.",
      fixable: true,
    });
  }

  const markInfo = catalog.lookup(PDFName.of("MarkInfo"));
  const marked =
    markInfo instanceof PDFDict && markInfo.get(PDFName.of("Marked"))?.toString() === "true";
  const hasStructure = catalog.get(PDFName.of("StructTreeRoot")) !== undefined;
  if (!marked || !hasStructure) {
    issues.push({
      id: "tagged",
      severity: "fail",
      summary: "Not tagged",
      detail:
        "Nothing in the file says which text is a heading, a list or a table, so a " +
        "screen reader reads the page as one undifferentiated block. Tagging cannot " +
        "be done here yet: it means deciding a reading order, which a tool should not " +
        "guess at silently.",
      fixable: false,
    });
  }

  const preferences = catalog.lookup(PDFName.of("ViewerPreferences"));
  const showsTitle =
    preferences instanceof PDFDict &&
    preferences.get(PDFName.of("DisplayDocTitle"))?.toString() === "true";
  if (!showsTitle) {
    issues.push({
      id: "displayTitle",
      severity: "warn",
      summary: "Window shows the file name, not the title",
      detail: "The reader's window names the file rather than the document.",
      fixable: true,
    });
  }

  const scanned = options.pagesWithoutText ?? [];
  if (scanned.length > 0) {
    issues.push({
      id: "scanned",
      severity: "fail",
      summary: `${scanned.length} page${scanned.length === 1 ? "" : "s"} with no text`,
      detail:
        "A scan with no text layer is a picture of words: a screen reader finds " +
        "nothing to read, and nothing can be searched or copied. Recognise the text " +
        "first.",
      fixable: false,
    });
  }

  if ((options.imageCount ?? 0) > 0 && (!marked || !hasStructure)) {
    issues.push({
      id: "alt",
      severity: "warn",
      summary: `${options.imageCount} picture${options.imageCount === 1 ? "" : "s"} with no description`,
      detail:
        "A picture with no alternate text is announced as nothing at all. " +
        "Descriptions live in the tag tree, so this follows tagging.",
      fixable: false,
    });
  }

  return issues;
}

export interface FixOptions {
  /** Used when the document has no title of its own. */
  title?: string;
  /** A BCP 47 tag: en, en-IN, ml, hi. */
  language?: string;
}

/**
 * Puts right what can be put right without guessing: the title, the language,
 * and the flag that makes a reader's window show the title rather than the file
 * name. Everything else is reported and left alone.
 */
export async function fixAccessibility(
  input: PdfBytes,
  options: FixOptions = {},
): Promise<PdfBytes> {
  const doc = await PDFDocument.load(input, { updateMetadata: false });

  const title = (doc.getTitle() ?? "").trim();
  if (title === "" && (options.title ?? "").trim() !== "") doc.setTitle(options.title!.trim());

  const language = (options.language ?? "en").trim();
  if (language !== "") doc.catalog.set(PDFName.of("Lang"), PDFString.of(language));

  const preferences = doc.catalog.lookup(PDFName.of("ViewerPreferences"));
  if (preferences instanceof PDFDict) {
    preferences.set(PDFName.of("DisplayDocTitle"), doc.context.obj(true));
  } else {
    doc.catalog.set(PDFName.of("ViewerPreferences"), doc.context.obj({ DisplayDocTitle: true }));
  }

  return doc.save();
}
