// Local file I/O only. Documents are read from and written to the user's own
// disk; nothing is uploaded and nothing is persisted unless the user saves
// (privacy invariants 1 and 4, CLAUDE.md §1).
//
// Three routes, picked at runtime:
//   * Inside the desktop shell, Tauri's native dialogs and filesystem. WKWebView
//     has no File System Access API at all, so without this the desktop app
//     would quietly use a hidden file input and "download" files — which is not
//     what a native application should do.
//   * In Chrome and Edge, the File System Access API, which can also write back
//     to the file that was opened.
//   * Everywhere else (Firefox, Safari), an <input type=file> and a download.

export interface PickedFile {
  name: string;
  /** MIME type as the browser reported it; empty for some drops. */
  type?: string | undefined;
  bytes: ArrayBuffer;
  /** Present only via the File System Access API; lets Save write back in place. */
  handle?: FileSystemFileHandle | undefined;
  /** Present only in the desktop shell; same purpose as `handle`. */
  path?: string | undefined;
}

const PDF_TYPES = [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }];

/**
 * Pictures the user may choose. pdf-lib embeds only PNG and JPEG, but a phone
 * photo or a screenshot is just as likely to be WebP or AVIF, so the rest are
 * offered and re-encoded by asEmbeddableImage() below. HEIC is deliberately
 * absent: no browser decodes it, and offering it would only fail later.
 */
export const IMAGE_TYPES = [
  {
    description: "Picture",
    accept: {
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "image/webp": [".webp"],
      "image/avif": [".avif"],
      "image/gif": [".gif"],
      "image/bmp": [".bmp"],
    },
  },
];

/**
 * True inside the Tauri shell. Tauri 2 puts this on the window; checking it
 * rather than a user-agent string means the same bundle works in both places.
 */
/**
 * The public try-it-out build.
 *
 * Everything works — open, edit, annotate, redact, OCR — except the last step,
 * taking a file away. Every path that writes a file for the user goes through
 * saveBytes, and printing goes through printBytes, so those two are the whole
 * of it rather than a guard on each of the twelve callers.
 *
 * It is a sign on a door, not a lock: the app runs entirely in the browser, so
 * anyone willing to open the developer tools can defeat it. It is there to send
 * an interested person to the installer, not to stop a determined one, and
 * nothing of value is being withheld — the installed app is what the trial is
 * advertising.
 */
export const TRIAL: boolean = __TRIAL__;

/** Where someone who wants to keep their work should go. */
export const DOWNLOAD_URL: string = __DOWNLOAD_URL__;

/** Raised to the interface so it can explain itself, rather than failing mutely. */
const TRIAL_EVENT = "signet:trial";

function heldBackByTrial(): boolean {
  if (!TRIAL) return false;
  window.dispatchEvent(new CustomEvent(TRIAL_EVENT));
  return true;
}

export function onTrialBlock(run: () => void): () => void {
  window.addEventListener(TRIAL_EVENT, run);
  return () => window.removeEventListener(TRIAL_EVENT, run);
}

export const isDesktop = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const canUsePicker = (): boolean => isDesktop() || "showOpenFilePicker" in globalThis;
export const canUseSavePicker = (): boolean => isDesktop() || "showSaveFilePicker" in globalThis;

/**
 * Tauri's APIs are imported only when running inside it, so a browser build
 * never loads them. They are a few kB, but a browser has no use for them.
 */
async function tauri() {
  const [dialog, core] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/api/core"),
  ]);
  return { dialog, invoke: core.invoke };
}

/**
 * Prints a document, by the only route each platform actually offers.
 *
 * In a browser the document is opened in a new tab, where the browser's own PDF
 * viewer prints it as vector — rasterising the pages ourselves would be a step
 * down in quality for no gain. The blob URL is local; nothing is uploaded.
 *
 * In the desktop shell there is no PDF viewer and no print dialog in the
 * webview, so the shell hands the file to the system viewer instead.
 *
 * Returns what to tell the user, or undefined when the print started cleanly.
 */
export async function printBytes(bytes: ArrayBuffer, name: string): Promise<string | undefined> {
  if (heldBackByTrial()) return undefined;
  if (isDesktop()) {
    const { invoke } = await tauri();
    await invoke<string>("print_document", {
      name: name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`,
      bytes: [...new Uint8Array(bytes)],
    });
    return "Opened in your PDF viewer — print from there";
  }

  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const tab = window.open(url, "_blank");
  if (!tab) {
    URL.revokeObjectURL(url);
    return "Allow pop-ups for this page to print, or save the file and print it";
  }
  // The tab needs the URL until it has loaded; a minute is more than enough and
  // leaking it for the life of the page would hold the document in memory.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "Opened in a new tab — print from there for full quality";
}

/** Office documents the desktop shell can convert, if LibreOffice is installed. */
export const OFFICE_EXTENSIONS = [
  "doc",
  "docx",
  "odt",
  "rtf",
  "xls",
  "xlsx",
  "ods",
  "ppt",
  "pptx",
  "odp",
];

/** Whether this machine can convert Office documents at all. */
export async function canConvertOffice(): Promise<boolean> {
  if (!isDesktop()) return false;
  const { invoke } = await tauri();
  return invoke<boolean>("can_convert_office");
}

/**
 * Converts an Office document to PDF with the machine's own LibreOffice
 * (ADR 0007). Browser builds have no converter and say so rather than
 * pretending; nothing is downloaded and nothing is sent anywhere.
 */
export async function convertOffice(file: PickedFile): Promise<ArrayBuffer> {
  const { invoke } = await tauri();
  const out = await invoke<number[]>("convert_office", {
    name: file.name,
    bytes: [...new Uint8Array(file.bytes)],
  });
  return new Uint8Array(out).buffer;
}

/** Whether this machine offers a way to scan at all. */
export async function canScan(): Promise<boolean> {
  if (!isDesktop()) return false;
  const { invoke } = await tauri();
  return invoke<boolean>("can_scan");
}

/**
 * Scans one page as a JPEG, through the machine's own scanner driver. A
 * browser cannot reach a scanner at all, which is one of the reasons the
 * desktop build exists (ADR 0005).
 */
export async function scanPage(dpi = 300): Promise<PickedFile> {
  const { invoke } = await tauri();
  const bytes = new Uint8Array(await invoke<number[]>("scan_page", { dpi }));
  return {
    name: `scan-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.jpg`,
    type: "image/jpeg",
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

const PDF_FILTER = [{ name: "PDF document", extensions: ["pdf"] }];
const IMAGE_FILTER = [
  { name: "Picture", extensions: ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp"] },
];

/** Reads the files a native dialog returned. Paths, not handles. */
async function readPaths(paths: string[]): Promise<PickedFile[]> {
  const { invoke } = await tauri();
  return Promise.all(
    paths.map(async (path) => {
      const bytes = new Uint8Array(await invoke<number[]>("read_document", { path }));
      return {
        name: path.split(/[\\/]/).pop() ?? path,
        type: path.toLowerCase().endsWith(".pdf") ? "application/pdf" : "",
        // A fresh buffer: the worker transfers what it is given.
        bytes: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        path,
      };
    }),
  );
}

/**
 * Opens the native picker. Returns [] if the user cancels.
 *
 * `kind` is what the dialog offers: PDFs, images, or anything at all — the
 * last for attaching a file, which can be a spreadsheet or a photograph.
 */
export async function pickFiles(
  multiple: boolean,
  kind: "pdf" | "image" | "office" | "any" = "pdf",
): Promise<PickedFile[]> {
  if (isDesktop()) {
    const { dialog } = await tauri();
    const chosen = await dialog.open({
      multiple,
      ...(kind === "any"
        ? {}
        : {
            filters:
              kind === "image"
                ? IMAGE_FILTER
                : kind === "office"
                  ? [{ name: "Office document", extensions: OFFICE_EXTENSIONS }]
                  : PDF_FILTER,
          }),
    });
    if (chosen === null) return [];
    return readPaths(Array.isArray(chosen) ? chosen : [chosen]);
  }

  const handles = await window
    .showOpenFilePicker({
      multiple,
      ...(kind === "any" || kind === "office"
        ? {}
        : { types: kind === "image" ? IMAGE_TYPES : PDF_TYPES }),
      excludeAcceptAllOption: false,
    })
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return [];
      throw err;
    });

  return Promise.all(
    handles.map(async (handle) => {
      const file = await handle.getFile();
      return { name: file.name, type: file.type, bytes: await file.arrayBuffer(), handle };
    }),
  );
}

export async function readFiles(files: FileList | File[]): Promise<PickedFile[]> {
  return Promise.all(
    Array.from(files).map(async (file) => ({
      name: file.name,
      type: file.type,
      bytes: await file.arrayBuffer(),
    })),
  );
}

/**
 * PNG or JPEG bytes from any picture the browser can decode.
 *
 * pdf-lib embeds those two formats only. The format used to be guessed from the
 * filename — anything without a .png extension was called a JPEG — so a WebP or
 * AVIF photo was accepted, placed, and then failed at save time with an error
 * about the wrong thing. Decoding it here re-encodes it to PNG on the device,
 * through the browser's own image decoder, so the failure happens at the moment
 * the user chooses the file, in words about that file.
 *
 * Nothing leaves the machine: createImageBitmap and OffscreenCanvas are local.
 */
export async function asEmbeddableImage(
  file: PickedFile,
): Promise<{ bytes: Uint8Array; format: "png" | "jpg" }> {
  const bytes = new Uint8Array(file.bytes);
  if (file.type === "image/png" || /\.png$/i.test(file.name)) return { bytes, format: "png" };
  if (file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name)) return { bytes, format: "jpg" };

  const blob = new Blob([bytes as BlobPart], { type: file.type ?? "" });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error(`${file.name} is not a picture this device can read — save it as PNG or JPEG`);
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error(`${file.name} could not be converted to a PNG`);
    context.drawImage(bitmap, 0, 0);
    const png = await canvas.convertToBlob({ type: "image/png" });
    return { bytes: new Uint8Array(await png.arrayBuffer()), format: "png" };
  } finally {
    bitmap.close();
  }
}

/**
 * Writes bytes to disk. Returns the name written, or undefined if the user
 * cancelled. Falls back to a download, which is the only option in browsers
 * without the save picker.
 */
export async function saveBytes(
  bytes: ArrayBuffer,
  suggestedName: string,
  handle?: FileSystemFileHandle,
  mime = "application/pdf",
  path?: string,
): Promise<string | undefined> {
  if (heldBackByTrial()) return undefined;
  if (isDesktop()) {
    const { dialog, invoke } = await tauri();
    // Writing back to the file that was opened needs no dialog, exactly as the
    // File System Access path does with a handle.
    const target =
      path ??
      (await dialog.save({
        defaultPath: suggestedName,
        filters: mime === "application/pdf" ? PDF_FILTER : IMAGE_FILTER,
      }));
    if (!target) return undefined;
    await invoke("write_document", { path: target, bytes: [...new Uint8Array(bytes)] });
    return target.split(/[\\/]/).pop() ?? target;
  }

  const blob = new Blob([bytes], { type: mime });

  if (canUseSavePicker()) {
    let target: FileSystemFileHandle;
    if (handle) {
      target = handle;
    } else {
      try {
        target = await window.showSaveFilePicker({
          suggestedName,
          types: mime === "application/pdf" ? PDF_TYPES : IMAGE_TYPES,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return undefined;
        throw err;
      }
    }
    const writable = await target.createWritable();
    await writable.write(blob);
    await writable.close();
    return target.name;
  }

  // blob: URLs stay on the device; the CSP allows them for workers and images and
  // does not govern a download link.
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.click();
  } finally {
    // Revoke on the next turn: the click has to be dispatched first.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return suggestedName;
}

/** "report.pdf" -> "report (merged).pdf" */
export function suffixName(name: string, suffix: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? `${name} (${suffix})` : `${name.slice(0, dot)} (${suffix})${name.slice(dot)}`;
}
