// The slice of the session's transcript the summariser reads each time it runs: what was said since the last
// pass, and what the tool calls in it touched.
import fs from "node:fs";
import { type ExtractTouchesOptions, extractTouches, NO_TOUCHES, type Touches } from "./touches.ts";

export const SLICE_BYTES = 20 * 1024;
const MAX_READ_BYTES = 512 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const texts: string[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (part?.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.join("\n");
}

// Keeps only what the user and the assistant said: no tool calls, tool results or thinking.
export function extractTranscriptText(jsonl: string): string {
  const turns: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown> | null;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || entry.isSidechain || entry.isMeta) {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") {
      continue;
    }
    const text = textOf(asRecord(entry.message)?.content).trim();
    if (!text) {
      continue;
    }
    turns.push(`${entry.type === "user" ? "User" : "Assistant"}: ${text}`);
  }
  return turns.join("\n\n");
}

/** The last `maxBytes` of `text`, with the partial character any cut through UTF-8 leaves dropped. */
export function tail(text: string, maxBytes: number = SLICE_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return text;
  }
  return buf
    .subarray(buf.length - maxBytes)
    .toString("utf8")
    .replace(/^�+/, "");
}

export type TranscriptSlice = {
  text: string;
  touches: Touches;
  end: number;
};

// Reads from the saved offset to the last complete line. A shrunk file (or a different
// transcript) starts again from 0.
export function readTranscriptSlice(file: string, offset = 0, opts: ExtractTouchesOptions = {}): TranscriptSlice {
  const empty: TranscriptSlice = { text: "", touches: NO_TOUCHES, end: offset };
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return empty;
  }
  if (offset > size) {
    offset = 0;
  }
  const start = Math.max(offset, size - MAX_READ_BYTES);
  const length = size - start;
  if (length <= 0) {
    return empty;
  }
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    return empty;
  }
  let chunk = buf.subarray(0, lastNewline + 1).toString("utf8");
  if (start > offset) {
    chunk = chunk.slice(chunk.indexOf("\n") + 1);
  }
  return { text: tail(extractTranscriptText(chunk)), touches: extractTouches(chunk, opts), end: start + lastNewline + 1 };
}
