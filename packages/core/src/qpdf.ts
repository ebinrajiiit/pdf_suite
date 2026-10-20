import createQpdfModule from "@neslinesli93/qpdf-wasm";
import type { PdfBytes } from "./ops.js";

/**
 * qpdf (Apache-2.0) compiled to WASM, for the jobs pdf-lib cannot do: repairing
 * damaged files, encryption, and recompression. See docs/adr/0003-qpdf-wasm.md.
 *
 * The wasm is loaded from a URL because this build has no `wasmBinary` option;
 * the URL must be same-origin, i.e. our own bundle, never a CDN (docs/PRIVACY.md).
 */
export interface QpdfOptions {
  wasmUrl: string;
}

export interface EncryptOptions {
  /** Needed to open the document. */
  userPassword: string;
  /** Needed to change permissions. Defaults to the user password. */
  ownerPassword?: string | undefined;
  bits?: 128 | 256 | undefined;
  /**
   * What a reader may do without the owner password. Left out, everything is
   * allowed and the password only controls opening.
   *
   * These are a request, not a guarantee: the PDF specification says a reader
   * should honour them, and most do, but the file is decrypted in the reader's
   * hands either way. Acrobat says the same thing in smaller type.
   */
  allow?:
    | {
        print?: "none" | "low" | "full" | undefined;
        modify?: "none" | "annotate" | "form" | "assembly" | "all" | undefined;
        extract?: boolean | undefined;
        /** Extraction for a screen reader, which is worth keeping separate. */
        accessibility?: boolean | undefined;
      }
    | undefined;
}

export class QpdfError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "QpdfError";
    this.exitCode = exitCode;
  }
}

export class WrongPasswordError extends QpdfError {
  constructor() {
    super("The password did not open this document", 2);
    this.name = "WrongPasswordError";
  }
}

/** qpdf exits 2 on an error and 3 when it succeeded despite warnings — which is
 *  what a successful repair looks like, so 3 counts as success. */
const EXIT_WARNING = 3;

export interface Qpdf {
  /**
   * Rewrites a damaged document. qpdf recovers some damage (a mangled header,
   * junk before the header, many broken cross-reference tables) and refuses
   * outright on others, which is why callers treat a throw as "still broken".
   */
  repair(bytes: PdfBytes): Promise<PdfBytes>;
  encrypt(bytes: PdfBytes, options: EncryptOptions): Promise<PdfBytes>;
  /** Removes encryption so the result can be edited; throws on a wrong password. */
  decrypt(bytes: PdfBytes, password: string): Promise<PdfBytes>;
  /** Recompresses streams and packs objects. Small files can come out larger. */
  compress(bytes: PdfBytes): Promise<PdfBytes>;
}

// There is deliberately no isEncrypted(): this build's --is-encrypted tries to
// open the file first, so it answers 2 both for "not encrypted" and for
// "encrypted and I have no password". The engine already tells us, by raising
// PasswordRequiredError from open().

interface QpdfInstance {
  callMain(args: string[]): number;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
}

export async function createQpdf(options: QpdfOptions): Promise<Qpdf> {
  const url = resolveSameOrigin(options.wasmUrl);
  // The package's own types describe a narrower FS than the build ships.
  const factory = createQpdfModule as unknown as (arg: {
    locateFile: () => string;
  }) => Promise<QpdfInstance>;
  const module = await factory({ locateFile: () => url });

  // callMain is synchronous and the module has one filesystem, so overlapping
  // calls would read each other's files. Serialise them.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => T): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  }

  let counter = 0;

  /** Runs qpdf over `input` and returns the output file, if it produced one. */
  function run(input: PdfBytes, args: (inFile: string, outFile: string) => string[]) {
    return serial(() => {
      const id = counter++;
      const inFile = `/in-${id}.pdf`;
      const outFile = `/out-${id}.pdf`;
      module.FS.writeFile(inFile, input);
      try {
        const code = module.callMain(args(inFile, outFile));
        if (code !== 0 && code !== EXIT_WARNING) {
          return { code, bytes: undefined };
        }
        return { code, bytes: module.FS.readFile(outFile) };
      } finally {
        for (const path of [inFile, outFile]) {
          try {
            module.FS.unlink(path);
          } catch {
            // Never written, because qpdf failed before producing it.
          }
        }
      }
    });
  }

  return {
    async repair(bytes) {
      const { code, bytes: out } = await run(bytes, (i, o) => [i, o]);
      if (!out) {
        throw new QpdfError(
          "qpdf could not reconstruct this document; it is damaged beyond repair",
          code,
        );
      }
      return out;
    },

    async encrypt(bytes, { userPassword, ownerPassword, bits = 256, allow }) {
      if (userPassword === "") throw new Error("a user password is required");
      // qpdf takes the permissions as flags between the key length and the --.
      const flags: string[] = [];
      if (allow?.print) flags.push(`--print=${allow.print}`);
      if (allow?.modify) flags.push(`--modify=${allow.modify}`);
      if (allow?.extract !== undefined) flags.push(`--extract=${allow.extract ? "y" : "n"}`);
      if (allow?.accessibility !== undefined && bits === 128) {
        // 256-bit encryption always allows extraction for accessibility, and
        // qpdf refuses the flag there rather than pretending.
        flags.push(`--accessibility=${allow.accessibility ? "y" : "n"}`);
      }

      const { code, bytes: out } = await run(bytes, (i, o) => [
        i,
        o,
        "--encrypt",
        userPassword,
        ownerPassword ?? userPassword,
        String(bits),
        ...flags,
        "--",
      ]);
      if (!out) throw new QpdfError("qpdf could not encrypt this document", code);
      return out;
    },

    async decrypt(bytes, password) {
      const { bytes: out } = await run(bytes, (i, o) => [
        `--password=${password}`,
        "--decrypt",
        i,
        o,
      ]);
      // qpdf's own message does not reach us (it writes past our handlers), but a
      // --decrypt that fails on a file we could read is almost always the password.
      if (!out) throw new WrongPasswordError();
      return out;
    },

    async compress(bytes) {
      const { code, bytes: out } = await run(bytes, (i, o) => [
        i,
        o,
        "--object-streams=generate",
        "--recompress-flate",
        "--compression-level=9",
      ]);
      if (!out) throw new QpdfError("qpdf could not recompress this document", code);
      return out;
    },
  };
}

/**
 * Engine assets must come from our own origin. Mirrors the PDFium adapter; in
 * Node (unit tests) there is no origin to compare against and a path is fine.
 */
function resolveSameOrigin(wasmUrl: string): string {
  const location = globalThis.location;
  if (!location) return wasmUrl;
  const url = new URL(wasmUrl, location.href);
  if (url.origin !== location.origin) {
    throw new Error(`wasmUrl must be same-origin (got ${url.origin}); see docs/PRIVACY.md`);
  }
  return url.href;
}
