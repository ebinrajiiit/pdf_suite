/**
 * A minimal ZIP writer, because a .docx is a ZIP and nothing else here needs
 * one.
 *
 * Entries are stored, not deflated. That makes the file larger than Word's own
 * — a text-only document is a few kilobytes either way — and it makes this
 * eighty lines instead of a dependency. The alternative was pulling in a
 * compression library to save a few kilobytes on a file nobody keeps.
 */

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  data: Uint8Array;
}

/** CRC-32, which every entry's header has to carry. */
export function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

/**
 * A fixed MS-DOS timestamp: 1 January 1980, midnight — the earliest the format
 * can express. Zero is not that; zero is month 0 day 0, which is not a date at
 * all, and strict readers are entitled to object. A constant also keeps the
 * output reproducible, which a timestamp of "now" would not.
 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // month 1, day 1, year 1980

export function zip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const sum = crc32(entry.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, sum, true);
    local.setUint32(18, entry.data.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // no extra field

    locals.push(new Uint8Array(local.buffer), name, entry.data);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true); // central directory header
    header.setUint16(4, 20, true); // version made by
    header.setUint16(6, 20, true); // version needed
    header.setUint16(8, 0, true);
    header.setUint16(10, 0, true); // stored
    header.setUint16(12, DOS_TIME, true);
    header.setUint16(14, DOS_DATE, true);
    header.setUint32(16, sum, true);
    header.setUint32(20, entry.data.length, true);
    header.setUint32(24, entry.data.length, true);
    header.setUint16(28, name.length, true);
    header.setUint16(30, 0, true);
    header.setUint16(32, 0, true);
    header.setUint16(34, 0, true);
    header.setUint16(36, 0, true);
    header.setUint32(38, 0, true);
    header.setUint32(42, offset, true);

    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.length + entry.data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true); // no comment

  const parts = [...locals, ...central, new Uint8Array(end.buffer)];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
