// The stop worker's feed notes wait here for the user's next prompt, which the UserPromptContext hook
// attaches them to. Pushing them through the inbox would start a turn of their own.
import fs from "node:fs";
import { CLI } from "./envelope.ts";
import { removeFile, statePath } from "./session.ts";

export const HELD_NOTES = "held-notes.jsonl";
export const MAX_HELD_NOTES = 20;
export const MAX_HELD_BYTES = 8 * 1024;

export type HeldNote = {
  at?: string;
  text: string;
  message_ids?: string[];
};

export function messageIds(text: string): string[] {
  return [...new Set([...String(text).matchAll(/#(\d+)\b/g)].map((m) => m[1] as string))];
}

// Keeps the newest notes that fit, so a session left alone for hours cannot grow the queue unbounded.
function capLines(lines: string[]): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_HELD_NOTES; i--) {
    const line = lines[i] as string;
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > MAX_HELD_BYTES && kept.length) {
      break;
    }
    kept.unshift(line);
    bytes += size;
  }
  return kept;
}

export function holdNote(sid: string, text: string, at: number = Date.now()): void {
  const file = statePath(sid, HELD_NOTES);
  const ids = messageIds(text);
  const note: HeldNote = { at: new Date(at).toISOString(), text, ...(ids.length ? { message_ids: ids } : {}) };
  fs.appendFileSync(file, `${JSON.stringify(note)}\n`, { mode: 0o600 });
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return;
  }
  const kept = capLines(lines);
  if (kept.length === lines.length) {
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${kept.join("\n")}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Null for anything that is not a note with something in it. The queue is append-only, so a line may have been
// written by an older version of this client, or be half a line from a process that died mid-write.
export function parseHeldNote(value: unknown): HeldNote | null {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!raw || typeof raw.text !== "string" || !raw.text.trim()) {
    return null;
  }
  const ids = Array.isArray(raw.message_ids) ? raw.message_ids.filter((id): id is string => typeof id === "string") : null;
  return {
    ...(typeof raw.at === "string" ? { at: raw.at } : {}),
    text: raw.text,
    ...(ids?.length ? { message_ids: ids } : {})
  };
}

// Renamed before it is read, so a note the stop worker appends meanwhile starts a new queue
// instead of being deleted unread.
export function takeHeldNotes(sid: string): HeldNote[] {
  const file = statePath(sid, HELD_NOTES);
  const taken = `${file}.${process.pid}.taking`;
  try {
    fs.renameSync(file, taken);
  } catch {
    return [];
  }
  let raw = "";
  try {
    raw = fs.readFileSync(taken, "utf8");
  } finally {
    removeFile(taken);
  }
  const notes: HeldNote[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const note = parseHeldNote(parsed);
    if (note) {
      notes.push(note);
    }
  }
  return notes;
}

export function heldNotesContext(notes: HeldNote[]): string {
  return [
    "agent-hub: the posts below were flagged in the background by this session's agent-hub stop worker as possibly relevant to the current work. They are NOT from the user and are not part of the prompt.",
    "Mention one to the user only if it genuinely matters to what they just asked or to the work in hand. Otherwise ignore them silently: do not comment on them or say you are ignoring them.",
    `Read a post in full with ${CLI} read <id>; reply to its author with ${CLI} reply <id> "<text>".`,
    ...notes.map((n) => `- (${n.at || "earlier"}) ${n.text}`)
  ].join("\n");
}
