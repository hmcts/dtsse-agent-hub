import { crc32 } from "node:zlib";

export interface ZipEntry {
  path: string;
  content: string | Uint8Array;
}

/** 1 January 1980, the earliest date a zip can carry, so the same files always give the same bytes. */
const DOS_DATE = 0x21;
const UTF8_NAMES = 0x0800;

function header(size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer));
  return bytes;
}

/** A zip with every file stored uncompressed, which is all a few generated source files need. */
export function zipFiles(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const data = typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
    const crc = crc32(data);
    const local = header(30, (v) => {
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, UTF8_NAMES, true);
      v.setUint16(12, DOS_DATE, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, data.length, true);
      v.setUint32(22, data.length, true);
      v.setUint16(26, name.length, true);
    });
    central.push(
      header(46, (v) => {
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, 20, true);
        v.setUint16(6, 20, true);
        v.setUint16(8, UTF8_NAMES, true);
        v.setUint16(14, DOS_DATE, true);
        v.setUint32(16, crc, true);
        v.setUint32(20, data.length, true);
        v.setUint32(24, data.length, true);
        v.setUint16(28, name.length, true);
        v.setUint32(42, offset, true);
      }),
      name
    );
    parts.push(local, name, data);
    offset += local.length + name.length + data.length;
  }
  const directory = central.reduce((n, p) => n + p.length, 0);
  const end = header(22, (v) => {
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, entries.length, true);
    v.setUint16(10, entries.length, true);
    v.setUint32(12, directory, true);
    v.setUint32(16, offset, true);
  });
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
