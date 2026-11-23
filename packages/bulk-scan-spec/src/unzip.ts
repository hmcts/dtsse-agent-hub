import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;
/** What one entry may expand to, so a crafted archive cannot exhaust memory. */
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;

/** The files of a zip whose path `wanted` accepts, inflated; the other entries are never read. */
export function unzipFiles(bytes: Uint8Array, wanted: (path: string) => boolean): { path: string; content: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY) {
    end--;
  }
  if (end < 0) {
    throw new Error("that is not a zip file");
  }
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files: { path: string; content: Uint8Array }[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== CENTRAL_ENTRY) {
      throw new Error("that zip's directory is damaged");
    }
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/") || !wanted(path)) {
      continue;
    }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method !== 0 && method !== 8) {
      throw new Error(`${path} in that zip uses a compression this reader does not know`);
    }
    files.push({ path, content: method === 0 ? data : inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }) });
  }
  return files;
}
