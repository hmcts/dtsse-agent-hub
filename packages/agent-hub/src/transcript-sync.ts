// Uploading the session's transcript to agent-hub, so its owner can read the conversation in the web UI. The
// upload is incremental: a byte offset into the JSONL file is saved beside the session's other state and only
// moves past batches the service took. Everything that leaves this module has been through the secret scanner.
import fs from "node:fs";
import { type Api, ApiError, type TranscriptEntry } from "./api.ts";
import type { Env } from "./env.ts";
import { findSecret } from "./secret-scan.ts";
import { log, readJson, removeFile, statePath, transcriptPath, writeJson } from "./session.ts";

export const MAX_CONTENT_BYTES = 16384;
export const MAX_BATCH_ENTRIES = 100;
// The service refuses requests over 256 KiB; this leaves room for the envelope and headers.
export const MAX_BATCH_BYTES = 200 * 1000;
export const BACKFILL_BYTES = 2 * 1024 * 1024;
const READ_BYTES = 1024 * 1024;
const SCAN_BYTES = 64 * 1024;
const KEY_RE = /^[A-Za-z0-9:_-]{1,200}$/;
const DIRECT_RE = /^\[agent-hub\] Direct message #(\d+) /;
const STATE_FILE = "transcript-sync.json";
const OFF_FILE = "transcript-off";
export const UNAVAILABLE_PAUSE_MS = 10 * 60 * 1000;

/** One entry as it goes on the wire, with the two flags the service treats as optional always decided. */
export type ScrubbedEntry = TranscriptEntry & {
  truncated: boolean;
  redacted: boolean;
  message_id: string | null;
};

/** An entry with the byte offset of the transcript line it came from, which is what the saved offset tracks. */
export type TranscriptItem = {
  start: number;
  entry: ScrubbedEntry;
};

export type ParsedLines = {
  items: TranscriptItem[];
  end: number;
};

const bytes = (value: unknown): number => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function transcriptOffByEnv(env: Env = process.env): boolean {
  return /^(off|false|0|no)$/i.test(String(env.AGENT_HUB_TRANSCRIPT || "").trim());
}

export function transcriptOffBySession(sid: string): boolean {
  return fs.existsSync(statePath(sid, OFF_FILE));
}

export function transcriptOff(sid: string, env: Env = process.env): boolean {
  return transcriptOffByEnv(env) || transcriptOffBySession(sid);
}

function textParts(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((raw) => {
      const part = asRecord(raw);
      return part?.type === "text" ? String(part.text ?? "") : part?.type === "image" ? "[image]" : `[${part?.type ?? "unknown"}]`;
    })
    .join("\n");
}

function directId(text: string): string | null {
  return DIRECT_RE.exec(text)?.[1] ?? null;
}

/**
 * The line Claude Code writes where a turn the user interrupted stopped. It is `type: "user"` and carries no
 * `isMeta`, so nothing above drops it, and uploaded it would show in the Assistant's thread as a message the person
 * typed — which they did not; they pressed Stop, and the thread says so in its own words. Matched on the text
 * because there is no flag for it: `interruptedMessageId` is on the line most of the time but not always.
 */
const INTERRUPT_NOTICES: readonly string[] = ["[Request interrupted by user]", "[Request interrupted by user for tool use]"];

function interruptNotice(text: string): boolean {
  return INTERRUPT_NOTICES.includes(text.trim());
}

/**
 * The entries one transcript line maps to, before secret scanning and truncation. The line is whatever Claude
 * Code appended to the JSONL, so every field it is read for is checked.
 */
export function toEntries(line: unknown): ScrubbedEntry[] {
  const raw = asRecord(line);
  if (!raw || raw.isSidechain) {
    return [];
  }
  const uuid = raw.uuid;
  const occurredAt = raw.timestamp;
  if (typeof uuid !== "string" || typeof occurredAt !== "string") {
    return [];
  }
  const type = raw.type;
  if (type !== "user" && type !== "assistant") {
    return [];
  }
  const content = asRecord(raw.message)?.content;
  const entry = (index: number, role: ScrubbedEntry["role"], body: Record<string, unknown>, messageId: string | null = null): ScrubbedEntry => ({
    key: `${uuid}:${index}`,
    role,
    content: body,
    truncated: false,
    redacted: false,
    message_id: messageId,
    occurred_at: occurredAt
  });
  const userText = (index: number, text: string) => entry(index, "user", { text }, directId(text));

  if (type === "user" && raw.isCompactSummary) {
    const text = typeof content === "string" ? content : textParts(content);
    return text.trim() ? [entry(0, "system", { text })] : [];
  }
  if (raw.isMeta) {
    return [];
  }
  if (type === "user" && interruptNotice(typeof content === "string" ? content : textParts(content))) {
    return [];
  }
  if (typeof content === "string") {
    if (!content.trim()) {
      return [];
    }
    return [type === "user" ? userText(0, content) : entry(0, "assistant", { text: content })];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const out: ScrubbedEntry[] = [];
  content.forEach((item, index) => {
    const part = asRecord(item);
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      out.push(type === "user" ? userText(index, part.text) : entry(index, "assistant", { text: part.text }));
    } else if (type === "user" && part?.type === "tool_result") {
      out.push(entry(index, "tool_result", { tool_use_id: String(part.tool_use_id ?? ""), output: textParts(part.content), is_error: part.is_error === true }));
    } else if (type === "assistant" && part?.type === "tool_use") {
      out.push(entry(index, "tool_use", { id: String(part.id ?? ""), name: String(part.name ?? ""), input: part.input ?? {} }));
    }
  });
  return out.filter((e) => KEY_RE.test(e.key));
}

function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) {
      stringLeaves(v, out);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringLeaves(v, out);
    }
  }
  return out;
}

// JSON escaping hides some secret shapes (a quote becomes \"), so the raw strings are scanned too.
function secretIn(content: unknown, patterns?: RegExp[]): string | null {
  return findSecret(stringLeaves(content).join("\n"), patterns) || findSecret(JSON.stringify(content), patterns);
}

function cut(text: string, length: number): string {
  const out = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

// The longest prefix of `text` whose content, as built by `build`, fits the byte limit.
function fit(text: string, build: (s: string) => Record<string, unknown>, limit: number): Record<string, unknown> {
  let lo = 0;
  let hi = Math.min(text.length, limit);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(build(cut(text, mid))) <= limit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return build(cut(text, lo));
}

export type ScrubOptions = {
  patterns?: RegExp[];
  limit?: number;
};

/** Redacts content holding a secret-shaped string, else truncates it to the service's size limit. */
export function scrub(entry: ScrubbedEntry, { patterns, limit = MAX_CONTENT_BYTES }: ScrubOptions = {}): ScrubbedEntry {
  const { content } = entry;
  const pattern = secretIn(content, patterns);
  if (pattern) {
    const redacted = entry.role === "tool_use" ? { id: content.id, name: content.name, redacted: pattern } : { redacted: pattern };
    return { ...entry, content: redacted, redacted: true, truncated: false };
  }
  if (bytes(content) <= limit) {
    return entry;
  }
  let fitted: Record<string, unknown>;
  if (entry.role === "tool_use") {
    const input = typeof content.input === "string" ? content.input : (JSON.stringify(content.input) ?? "");
    fitted = fit(input, (s) => ({ ...content, input: s }), limit);
  } else if (entry.role === "tool_result") {
    fitted = fit(String(content.output ?? ""), (s) => ({ ...content, output: s }), limit);
  } else {
    fitted = fit(String(content.text ?? ""), (s) => ({ text: s }), limit);
  }
  return { ...entry, content: fitted, truncated: true };
}

export type ParseLinesOptions = {
  base?: number;
  patterns?: RegExp[];
};

/**
 * Splits complete JSONL lines into scrubbed entries, each with the byte offset of the line it came
 * from (`base` is the offset of the first byte of `text`). A trailing partial line is ignored.
 */
export function parseLines(text: string | Buffer, { base = 0, patterns }: ParseLinesOptions = {}): ParsedLines {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
  const items: TranscriptItem[] = [];
  let start = 0;
  for (let nl = buf.indexOf(0x0a, start); nl !== -1; start = nl + 1, nl = buf.indexOf(0x0a, start)) {
    const raw = buf.toString("utf8", start, nl);
    if (!raw.trim()) {
      continue;
    }
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const entry of toEntries(line)) {
      items.push({ start: base + start, entry: scrub(entry, { patterns }) });
    }
  }
  return { items, end: base + start };
}

export function parseEntries(text: string | Buffer, opts: ParseLinesOptions = {}): ScrubbedEntry[] {
  return parseLines(text, opts).items.map((item) => item.entry);
}

export type BatchOptions = {
  sid?: string;
  maxEntries?: number;
  maxBytes?: number;
};

/** Groups items into requests of at most `maxEntries` entries and about `maxBytes` of JSON each. */
export function batchItems(
  items: TranscriptItem[],
  { sid = "", maxEntries = MAX_BATCH_ENTRIES, maxBytes = MAX_BATCH_BYTES }: BatchOptions = {}
): TranscriptItem[][] {
  const overhead = bytes({ session_id: sid, entries: [] });
  const batches: TranscriptItem[][] = [];
  let current: TranscriptItem[] = [];
  let size = overhead;
  for (const item of items) {
    const n = bytes(item.entry) + 1;
    if (current.length && (current.length >= maxEntries || size + n > maxBytes)) {
      batches.push(current);
      current = [];
      size = overhead;
    }
    current.push(item);
    size += n;
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

function readAt(file: string, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    const n = fs.readSync(fd, buf, 0, length, position);
    return n === length ? buf : buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// The start of the first line beginning at or after `position`.
function lineStartFrom(file: string, position: number, size: number): number {
  if (position <= 0) {
    return 0;
  }
  for (let at = position - 1; at < size; at += SCAN_BYTES) {
    const nl = readAt(file, at, Math.min(SCAN_BYTES, size - at)).indexOf(0x0a);
    if (nl !== -1) {
      return at + nl + 1;
    }
  }
  return size;
}

// The end of the last complete line.
function lastLineEnd(file: string, size: number): number {
  for (let end = size; end > 0; end -= SCAN_BYTES) {
    const at = Math.max(0, end - SCAN_BYTES);
    const nl = readAt(file, at, end - at).lastIndexOf(0x0a);
    if (nl !== -1) {
      return at + nl + 1;
    }
  }
  return 0;
}

export function backfillStart(file: string, size: number, maxBytes: number = BACKFILL_BYTES): number {
  return size <= maxBytes ? 0 : lineStartFrom(file, size - maxBytes, size);
}

// From `offset` to the end of the last complete line, reading further when one line outgrows a read.
function readCompleteLines(file: string, offset: number, size: number): Buffer | null {
  for (let length = READ_BYTES; ; length *= 2) {
    const buf = readAt(file, offset, Math.min(length, size - offset));
    const nl = buf.lastIndexOf(0x0a);
    if (nl !== -1) {
      return buf.subarray(0, nl + 1);
    }
    if (offset + buf.length >= size) {
      return null;
    }
  }
}

function statSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

export function syncStatePath(sid: string): string {
  return statePath(sid, STATE_FILE);
}

export type SyncState = {
  agent_id: string | null;
  path: string;
  offset: number;
  floor: number;
};

export type SavedState = {
  agent_id: string | null;
  path: string | null;
  offset: number | null;
  floor: number | null;
};

// Null for a file that is not an object; every field that is not the shape this module writes is dropped, which
// makes it look to the caller like state an older version of this client never wrote. Exported because the CLI's
// `transcript status` reads the same file, and a second narrowing of it would be a second thing to keep honest.
export function parseSavedState(value: unknown): SavedState | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    agent_id: typeof raw.agent_id === "string" ? raw.agent_id : null,
    path: typeof raw.path === "string" ? raw.path : null,
    offset: Number.isInteger(raw.offset) ? (raw.offset as number) : null,
    floor: Number.isInteger(raw.floor) ? (raw.floor as number) : null
  };
}

export type FastForwardOptions = {
  agentId?: string | null;
  file?: string | null;
};

/**
 * Moves the upload offset to the end of the transcript without uploading, and records it as a floor
 * that a later reset (a new agent id) never backfills below. Used while uploads are off.
 */
export function fastForward(sid: string, { agentId, file = transcriptPath(sid) }: FastForwardOptions = {}): SyncState | null {
  if (!file) {
    return null;
  }
  const size = statSize(file);
  if (size === null) {
    return null;
  }
  const previous = parseSavedState(readJson(syncStatePath(sid)));
  const end = lastLineEnd(file, size);
  const state: SyncState = { agent_id: agentId ?? previous?.agent_id ?? null, path: file, offset: end, floor: end };
  writeJson(syncStatePath(sid), state);
  return state;
}

export function setTranscriptOff(sid: string, off: boolean): void {
  if (off) {
    fs.writeFileSync(statePath(sid, OFF_FILE), `${new Date().toISOString()}\n`);
  } else {
    removeFile(statePath(sid, OFF_FILE));
  }
}

export type TickStatus = "no-agent" | "paused" | "no-transcript" | "off" | "ok" | "unavailable" | "error";

export type TickResult = {
  status: TickStatus;
  uploaded: number;
  error?: Error;
};

export type TickOptions = {
  deadline?: number;
  timeoutMs?: number;
};

export type TranscriptSync = {
  tick: (opts?: TickOptions) => Promise<TickResult>;
};

export type CreateTranscriptSyncOptions = {
  sid: string;
  api: Pick<Api, "transcript">;
  agentId: string | null | (() => string | null);
  env?: Env;
  patterns?: RegExp[];
  resolvePath?: () => string | null;
  backfillBytes?: number;
  now?: () => number;
};

/**
 * Uploads the session's transcript to agent-hub incrementally. `tick()` sends every complete line
 * added since the saved offset and advances the offset only past batches the service accepted
 * (or refused with 400, so one bad batch cannot stop the sync).
 */
export function createTranscriptSync({
  sid,
  api,
  agentId,
  env = process.env,
  patterns,
  resolvePath = () => transcriptPath(sid, null) || transcriptPath(sid),
  backfillBytes = BACKFILL_BYTES,
  now = Date.now
}: CreateTranscriptSyncOptions): TranscriptSync {
  const getAgentId = typeof agentId === "function" ? agentId : () => agentId;
  const stateFile = syncStatePath(sid);
  let lastError: string | null = null;
  let pausedUntil = 0;

  function noteError(message: string) {
    if (message === lastError) {
      return;
    }
    lastError = message;
    log(sid, `transcript sync failed (retrying): ${message}`);
  }

  function currentState(id: string, file: string, size: number): SyncState {
    const saved = parseSavedState(readJson(stateFile));
    const shrank = saved?.path === file && !(saved.offset !== null && saved.offset <= size);
    if (saved && saved.agent_id === id && saved.path === file && !shrank) {
      return { agent_id: id, path: file, offset: saved.offset as number, floor: saved.floor ?? 0 };
    }
    const floor = saved?.path === file && !shrank && saved.floor !== null ? saved.floor : 0;
    const state: SyncState = { agent_id: id, path: file, offset: Math.max(backfillStart(file, size, backfillBytes), floor), floor };
    writeJson(stateFile, state);
    if (saved) {
      log(
        sid,
        `transcript sync reset (${saved.path !== file ? "new transcript" : shrank ? "transcript shrank" : "new agent"}); starting at byte ${state.offset}`
      );
    }
    return state;
  }

  async function tick({ deadline = Infinity, timeoutMs }: TickOptions = {}): Promise<TickResult> {
    const id = getAgentId();
    if (!id) {
      return { status: "no-agent", uploaded: 0 };
    }
    if (now() < pausedUntil) {
      return { status: "paused", uploaded: 0 };
    }
    const file = resolvePath();
    const size = file ? statSize(file) : null;
    if (!file || size === null) {
      return { status: "no-transcript", uploaded: 0 };
    }
    if (transcriptOff(sid, env)) {
      fastForward(sid, { agentId: id, file });
      return { status: "off", uploaded: 0 };
    }

    const state = currentState(id, file, size);
    const save = () => writeJson(stateFile, state);
    let uploaded = 0;
    while (state.offset < size && Date.now() < deadline) {
      const chunk = readCompleteLines(file, state.offset, size);
      if (!chunk) {
        break;
      }
      const { items, end } = parseLines(chunk, { base: state.offset, patterns });
      const batches = batchItems(items, { sid });
      for (const [i, batch] of batches.entries()) {
        if (Date.now() >= deadline || transcriptOff(sid, env)) {
          return { status: "ok", uploaded };
        }
        const entries = batch.map((item) => item.entry);
        const remaining = Number.isFinite(deadline) ? Math.max(500, deadline - Date.now()) : undefined;
        try {
          await api.transcript(id, { session_id: sid, entries }, { timeoutMs: timeoutMs ?? remaining });
          uploaded += entries.length;
        } catch (e) {
          if (e instanceof ApiError && e.status === 400) {
            const first = entries[0] as TranscriptEntry;
            const last = entries[entries.length - 1] as TranscriptEntry;
            log(sid, `transcript batch refused, skipping ${entries.length} entries (${first.key} … ${last.key}): ${e.message}`);
          } else if (e instanceof ApiError && e.status === 404) {
            // A service without the transcript endpoint answers 404 too, so this pauses rather than
            // re-registering; the heartbeat and stream already catch an agent the service has forgotten.
            pausedUntil = now() + UNAVAILABLE_PAUSE_MS;
            log(sid, `transcript upload answered 404; pausing uploads for ${UNAVAILABLE_PAUSE_MS / 60000} minutes`);
            return { status: "unavailable", uploaded };
          } else {
            const error = e instanceof Error ? e : new Error(String(e));
            noteError(error.message);
            return { status: "error", uploaded, error };
          }
        }
        // A line whose entries straddle two batches is resent whole; the service ignores the duplicates.
        const next = batches[i + 1];
        state.offset = next ? (next[0] as TranscriptItem).start : end;
        save();
      }
      if (state.offset < end) {
        state.offset = end;
        save();
      }
    }
    if (lastError) {
      log(sid, "transcript sync recovered");
      lastError = null;
    }
    return { status: "ok", uploaded };
  }

  return { tick };
}
