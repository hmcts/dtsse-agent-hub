import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { zipFiles } from "./zip.ts";

/** Reads the central directory back: each file's name, size, checksum and the bytes its local header points to. */
function entriesOf(zip: Uint8Array): { name: string; crc: number; content: string }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    const nameLength = view.getUint16(at + 28, true);
    const size = view.getUint32(at + 24, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true);
    out.push({ name, crc: view.getUint32(at + 16, true), content: new TextDecoder().decode(zip.subarray(start, start + size)) });
    at += 46 + nameLength;
  }
  return out;
}

describe("zip", () => {
  it("should hold each file under its path with its content and checksum", () => {
    const zip = zipFiles([
      { path: "a/b.txt", content: "hello" },
      { path: "c.json", content: new TextEncoder().encode('{"é":1}') }
    ]);
    expect(entriesOf(zip)).toEqual([
      { name: "a/b.txt", crc: crc32("hello"), content: "hello" },
      { name: "c.json", crc: crc32('{"é":1}'), content: '{"é":1}' }
    ]);
  });

  it("should give the same bytes for the same files when made twice", () => {
    expect(zipFiles([{ path: "x", content: "y" }])).toEqual(zipFiles([{ path: "x", content: "y" }]));
  });

  it("should be a valid empty archive when there are no files", () => {
    expect(entriesOf(zipFiles([]))).toEqual([]);
  });
});
