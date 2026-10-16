// Local file I/O only. Documents are read from and written to the user's own
// disk; nothing is uploaded and nothing is persisted unless the user saves
// (privacy invariants 1 and 4, CLAUDE.md §1).
//
// The File System Access API is used where it exists, with an <input type=file>
// and a download fallback elsewhere (Firefox and Safari have no picker).

export interface PickedFile {
  name: string;
  /** MIME type as the browser reported it; empty for some drops. */
  type?: string | undefined;
  bytes: ArrayBuffer;
  /** Present only via the File System Access API; lets Save write back in place. */
  handle?: FileSystemFileHandle | undefined;
}

const PDF_TYPES = [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }];

/** Images we can turn into a PDF. HEIC is deliberately absent: pdf-lib cannot
 *  embed it, and silently skipping a dropped file is worse than saying so. */
export const IMAGE_TYPES = [
  { description: "Image", accept: { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"] } },
];

export const canUsePicker = (): boolean => "showOpenFilePicker" in globalThis;
export const canUseSavePicker = (): boolean => "showSaveFilePicker" in globalThis;

/** Opens the native picker. Returns [] if the user cancels. */
export async function pickFiles(multiple: boolean): Promise<PickedFile[]> {
  const handles = await window
    .showOpenFilePicker({ multiple, types: PDF_TYPES, excludeAcceptAllOption: false })
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
 * Writes bytes to disk. Returns the name written, or undefined if the user
 * cancelled. Falls back to a download, which is the only option in browsers
 * without the save picker.
 */
export async function saveBytes(
  bytes: ArrayBuffer,
  suggestedName: string,
  handle?: FileSystemFileHandle,
  mime = "application/pdf",
): Promise<string | undefined> {
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
