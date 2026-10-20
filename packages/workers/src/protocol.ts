// Typed worker protocol. Every request carries an id so responses can be matched,
// progress reported and long operations cancelled (docs/ARCHITECTURE.md).
//
// The worker owns the document bytes: a 200 MB file is posted in once and never
// posted back, only derived results (page sizes, bitmaps, saved bytes) are.

import type { EncryptOptions } from "@pdf-suite/core";
import type {
  AccessibilityIssue,
  Annotation,
  Attachment,
  ExistingAnnotation,
  Layer,
  Link,
  LinkTarget,
  Reply,
  DocumentDiff,
  NewField,
  Bookmark,
  Box,
  PageLabelRange,
  WatermarkOptions,
  DocumentProperties,
  SanitiseOptions,
  SanitiseReport,
  FieldValues,
  FormInfo,
  StampOptions,
} from "@pdf-suite/core";
import type { OutlineItem, TextRun } from "@pdf-suite/engine";
import type {
  EditableText,
  FindRequest,
  ImageEdit,
  ImageEditResult,
  PageImage,
  Found,
  RedactArea,
  RedactionResult,
  TextEdit,
  TextEditResult,
} from "@pdf-suite/engine/pdfium";
import type { OcrAssets } from "@pdf-suite/ocr";
/**
 * `order` on a request is source page indices in their display positions, with
 * omitted pages deleted. Every request that rewrites bytes applies it first, so
 * a deletion cannot come back to life when the document is next rewritten.
 */
export interface DocumentInfo {
  pageCount: number;
  /** PDF points, rotation applied. */
  pageSizes: { width: number; height: number }[];
  /** Set when the file was damaged and qpdf reconstructed it to open it. */
  repaired?: boolean;
  /** Set when the document arrived encrypted and will be re-protected on save. */
  protected?: boolean;
  /** Steps that can be undone, and redone: what the Undo and Redo buttons need. */
  undo: number;
  redo: number;
  /** The document's bookmarks, empty when it has none. */
  outline: OutlineItem[];
  /** The document's form fields, if it has an AcroForm. */
  form: FormInfo;
  /** Title, author, subject, keywords — what the file says about itself. */
  properties: DocumentProperties;
  /** Marks the document already carries, as opposed to ones placed here. */
  marks: ExistingAnnotation[];
  /** Optional content groups — layers — with whether each is on. */
  layers: Layer[];
}

/**
 * Pending annotations travel with every request that rewrites bytes, like
 * `order` does, and are applied *before* the order is materialised: they are
 * keyed by source page index, which reordering would otherwise invalidate.
 */
export type { EncryptOptions } from "@pdf-suite/core";
export type {
  AccessibilityIssue,
  Annotation,
  Attachment,
  ExistingAnnotation,
  Layer,
  Link,
  LinkTarget,
  Reply,
  DocumentDiff,
  PageDiff,
  NewField,
  AnnotRect,
  Bookmark,
  Box,
  PageLabelRange,
  WatermarkOptions,
  DocumentProperties,
  SanitiseOptions,
  SanitiseReport,
  FieldValues,
  FormField,
  FormInfo,
  NumberFormat,
  Slots,
  StampOptions,
} from "@pdf-suite/core";
export type { OutlineItem, TextRun } from "@pdf-suite/engine";
export type {
  EditableText,
  FindRequest,
  Found,
  ImageEdit,
  ImageEditResult,
  PageImage,
  PatternName,
  RedactArea,
  RedactRect,
  RedactionResult,
  TextEdit,
  TextEditResult,
} from "@pdf-suite/engine/pdfium";
export type { OcrAssets } from "@pdf-suite/ocr";

/** One search hit, in the display position the user is looking at. */
export interface SearchHit {
  /** Display position, not the source page index. */
  position: number;
  /** Source page index, for rendering. */
  page: number;
  snippet: string;
  /** Boxes to highlight, in PDF points with the origin at the page bottom-left. */
  rects: { x: number; y: number; w: number; h: number }[];
}

export type WorkerRequest = { id: number } &
  /** `qpdfWasmUrl` must be same-origin; qpdf is only loaded when first needed. */
  (
    | { kind: "init"; wasmBinary: ArrayBuffer; qpdfWasmUrl: string }
    | { kind: "open"; bytes: ArrayBuffer }
    /**
     * Supplies the password for a document whose open() raised
     * PasswordRequiredError. The worker still holds those bytes, so they are not
     * sent again — open() transferred them, which detaches the sender's copy.
     */
    | { kind: "unlock"; password: string }
    /**
     * Appends the given documents to the open one and reopens the result. Where
     * the new pages appear is the caller's choice, made by setting the display
     * order afterwards.
     */
    | { kind: "merge"; inputs: ArrayBuffer[]; order: number[]; annotations: Annotation[] }
    | { kind: "render"; page: number; scale: number }
    /** Extracted text for one source page, used to snap highlights to lines. */
    | { kind: "text"; page: number }
    /** Rotates the given display positions by `by` degrees and reopens the result. */
    | {
        kind: "rotate";
        positions: number[];
        by: 90 | 180 | 270;
        order: number[];
        annotations: Annotation[];
      }
    /**
     * Draws headers, footers and page numbers into the pages, then reopens the
     * result. `options.pages` is display positions, like everything else the UI
     * sends; the worker turns them into source pages.
     */
    | { kind: "stamp"; options: StampOptions; order: number[]; annotations: Annotation[] }
    /** Writes the document's title, author, subject and keywords. */
    | {
        kind: "setProperties";
        properties: Partial<DocumentProperties>;
        order: number[];
        annotations: Annotation[];
      }
    /**
     * Removes what the document carries but does not show: metadata, embedded
     * files, scripts, and optionally comments and links.
     */
    | {
        kind: "sanitise";
        options: SanitiseOptions;
        order: number[];
        annotations: Annotation[];
      }
    /** Replaces the document's bookmarks with the tree given. */
    | { kind: "setOutline"; bookmarks: Bookmark[]; order: number[]; annotations: Annotation[] }
    /**
     * Checks whether the document can be read by a screen reader. Reports only;
     * `fixAccessible` is what changes anything.
     */
    | { kind: "checkAccessible"; order: number[]; annotations: Annotation[] }
    /** Sets the title, language and window-title flag. */
    | {
        kind: "fixAccessible";
        title: string;
        language: string;
        order: number[];
        annotations: Annotation[];
      }
    /** Crops pages to a box given in the reader's own coordinates. */
    | {
        kind: "crop";
        box: Box | null;
        pages?: number[];
        order: number[];
        annotations: Annotation[];
      }
    /** Draws a watermark across pages, behind or over their content. */
    | {
        kind: "watermark";
        options: WatermarkOptions;
        order: number[];
        annotations: Annotation[];
      }
    /** Sets what the viewer's page box shows for each run of pages. */
    | {
        kind: "pageLabels";
        ranges: PageLabelRange[];
        order: number[];
        annotations: Annotation[];
      }
    /** Reports what is hidden in the document, changing nothing. */
    | { kind: "findHidden"; order: number[]; annotations: Annotation[] }
    /** Recompresses the document, reopening the result. */
    | { kind: "compress"; order: number[]; annotations: Annotation[] }
    /**
     * Writes form field values, optionally flattening them so they can no longer
     * be edited, then reopens the result.
     */
    | {
        kind: "fillForm";
        values: FieldValues;
        flatten: boolean;
        order: number[];
        annotations: Annotation[];
      }
    /** Turns layers on and off, by the ids the info reported. */
    | {
        kind: "setLayers";
        visibility: Record<string, boolean>;
        order: number[];
        annotations: Annotation[];
      }
    /** Every link in the document, with where it goes. */
    | { kind: "links"; order: number[]; annotations: Annotation[] }
    /** Adds a link box to a page. */
    | {
        kind: "addLink";
        link: { page: number; x: number; y: number; w: number; h: number; target: LinkTarget };
        order: number[];
        annotations: Annotation[];
      }
    /** The document's marks as an XFDF file, for sending to a reviewer. */
    | { kind: "exportXfdf"; name: string; order: number[]; annotations: Annotation[] }
    /** Imports marks from an XFDF file a reviewer sent back. */
    | { kind: "importXfdf"; xml: string; order: number[]; annotations: Annotation[] }
    /** Answers a mark, or sets its review state. */
    | { kind: "reply"; reply: Reply; order: number[]; annotations: Annotation[] }
    /** Removes a mark the document already carried. */
    | {
        kind: "deleteMark";
        page: number;
        index: number;
        order: number[];
        annotations: Annotation[];
      }
    /** Compares another document with this one, page by page, and reports. */
    | { kind: "compare"; other: ArrayBuffer; order: number[]; annotations: Annotation[] }
    /** Files carried inside the document. */
    | { kind: "attachments"; order: number[]; annotations: Annotation[] }
    | {
        kind: "attach";
        file: { name: string; bytes: ArrayBuffer; type?: string | undefined };
        order: number[];
        annotations: Annotation[];
      }
    | { kind: "readAttachment"; name: string; order: number[]; annotations: Annotation[] }
    | { kind: "removeAttachment"; name: string; order: number[]; annotations: Annotation[] }
    /** Adds a form field to a page, then reopens the result. */
    | { kind: "addField"; field: NewField; order: number[]; annotations: Annotation[] }
    /** Removes a form field by name. */
    | { kind: "removeField"; name: string; order: number[]; annotations: Annotation[] }
    /** The images on one source page, with where each sits. */
    | { kind: "images"; page: number; order: number[]; annotations: Annotation[] }
    /** Moves, resizes or removes images, then reopens the result. */
    | { kind: "editImages"; edits: ImageEdit[]; order: number[]; annotations: Annotation[] }
    /** The paragraphs on one source page that can be edited in place. */
    | { kind: "editableText"; page: number; order: number[]; annotations: Annotation[] }
    /** Replaces the text of the named paragraphs, re-wrapping each one. */
    | { kind: "editText"; edits: TextEdit[]; order: number[]; annotations: Annotation[] }
    /**
     * Finds personal numbers, addresses or words across the document and returns
     * boxes tight enough to redact. Finding and removing are separate requests
     * on purpose: nothing is destroyed until the count has been shown.
     */
    | { kind: "findPattern"; request: FindRequest; order: number[]; annotations: Annotation[] }
    /** Removes the content inside the given areas, then verifies it is gone. */
    | { kind: "redact"; areas: RedactArea[]; order: number[]; annotations: Annotation[] }
    /**
     * Sets the password the document is saved with, or null to remove
     * protection, and what a reader may do without the owner password.
     */
    | { kind: "protect"; password: string | null; allow?: EncryptOptions["allow"] }
    /**
     * Searches the pages in `order`, reporting progress per page. Long documents
     * are why the protocol has cancellation: a search over 500 pages extracts
     * text from every one of them.
     */
    | { kind: "search"; query: string; order: number[]; limit?: number }
    | { kind: "save"; order: number[]; annotations: Annotation[] }
    /**
     * Splits the document at the given display positions, each starting a new
     * part. Returns one document per part, in order.
     */
    | { kind: "split"; at: number[]; order: number[]; annotations: Annotation[] }
    /** Builds a document from images and opens it. */
    | { kind: "fromImages"; images: { bytes: ArrayBuffer; type: string }[] }
    /** The document's text, in display order, for saving as a plain text file. */
    | { kind: "toText"; order: number[] }
    /** Renders the given display positions to PNG, for export. */
    | { kind: "toImages"; positions: number[]; order: number[]; scale: number }
    /**
     * Makes the given display positions searchable with OCR. Pages that already
     * have a text layer are left exactly as they are.
     */
    | {
        kind: "ocr";
        positions: number[];
        order: number[];
        annotations: Annotation[];
        languages: string[];
        assets: OcrAssets;
        /** Rasterisation DPI; 300 is the usual floor for OCR. */
        dpi?: number;
        /**
         * Clean speckle off the page before recognising it. Measured to turn 8%
         * salt-and-pepper noise from 0% accuracy into 100% (ADR 0004), at the
         * cost of embedding the cleaned image rather than the original.
         */
        despeckle?: boolean;
      }
    /**
     * Steps back to, or forward to, another version of this document. The order
     * and annotations sent are the ones in force now, so the step in the other
     * direction restores them.
     */
    | { kind: "undo"; order: number[]; annotations: Annotation[] }
    | { kind: "redo"; order: number[]; annotations: Annotation[] }
    | { kind: "close" }
    | { kind: "cancel"; target: number }
  );

export type WorkerResponse = { id: number } & (
  | { kind: "ready" }
  | { kind: "document"; info: DocumentInfo }
  | { kind: "bitmap"; bitmap: ImageBitmap }
  | { kind: "saved"; bytes: ArrayBuffer }
  | { kind: "hits"; hits: SearchHit[]; truncated: boolean }
  | { kind: "runs"; runs: TextRun[] }
  | { kind: "editable"; runs: EditableText[] }
  | { kind: "pageImages"; images: PageImage[] }
  | { kind: "text"; text: string }
  | { kind: "attached"; files: Attachment[] }
  | { kind: "compared"; diff: DocumentDiff }
  | { kind: "xfdf"; xml: string }
  | { kind: "links"; links: Link[] }
  | { kind: "imported"; info: DocumentInfo; added: number; dropped: number; skipped: number }
  | { kind: "attachment"; name: string; bytes: ArrayBuffer }
  | {
      kind: "imagesEdited";
      info: DocumentInfo;
      applied: number;
      rejected: ImageEditResult["rejected"];
    }
  | { kind: "found"; found: Found }
  | { kind: "hidden"; report: SanitiseReport }
  | { kind: "accessibility"; issues: AccessibilityIssue[] }
  | { kind: "sanitised"; info: DocumentInfo; removed: SanitiseReport; wasClean: boolean }
  | {
      kind: "edited";
      info: DocumentInfo;
      applied: number;
      /** Blocks whose font could not draw the new text and was replaced. */
      substituted: TextEditResult["substituted"];
      /** Lines added beyond what a block had, which may overlap what follows. */
      addedLines: number;
      rejected: TextEditResult["rejected"];
    }
  | { kind: "parts"; parts: ArrayBuffer[] }
  | { kind: "images"; images: { position: number; bytes: ArrayBuffer }[] }
  | { kind: "ocrDone"; info: DocumentInfo; recognised: number; skipped: number }
  | {
      kind: "redacted";
      info: DocumentInfo;
      removed: Record<number, number>;
      verified: boolean;
      leftovers: RedactionResult["leftovers"];
    }
  /** A document put back as it was, with the page order and marks of that moment. */
  | { kind: "restored"; info: DocumentInfo; order: number[]; annotations: Annotation[] }
  | { kind: "closed" }
  | { kind: "progress"; done: number; total: number }
  | { kind: "cancelled" }
  | { kind: "error"; message: string; name: string }
);

/** Replies that complete a request; `progress` does not. */
export type TerminalResponse = Extract<
  WorkerResponse,
  {
    kind:
      | "ready"
      | "document"
      | "bitmap"
      | "saved"
      | "hits"
      | "runs"
      | "editable"
      | "pageImages"
      | "text"
      | "attached"
      | "attachment"
      | "compared"
      | "xfdf"
      | "links"
      | "imported"
      | "imagesEdited"
      | "found"
      | "hidden"
      | "accessibility"
      | "sanitised"
      | "edited"
      | "parts"
      | "images"
      | "ocrDone"
      | "redacted"
      | "restored"
      | "closed"
      | "cancelled"
      | "error";
  }
>;

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}
