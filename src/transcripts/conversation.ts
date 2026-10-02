import type { ThreadMessage } from "../messages/direct-thread.ts";
import { byCodePoint } from "../topics/slug.ts";
import type { TranscriptContent, TranscriptRole } from "./schema.ts";

/**
 * An agent's conversation as its page shows it: the hub's direct messages and its session's transcript in one time
 * line. Pure, so the server's first page and the browser's live top-ups and earlier pages are merged the same way.
 */

export interface TranscriptEntryView {
  id: string;
  key: string;
  session_id: string;
  role: TranscriptRole;
  content: TranscriptContent;
  truncated: boolean;
  redacted: boolean;
  message_id: string | null;
  occurred_at: string;
}

export interface ConversationPage {
  /** Oldest first. */
  messages: ThreadMessage[];
  /** Oldest first. */
  entries: TranscriptEntryView[];
  /** The entry id to ask for earlier entries before, or `null` when this page reaches the start of the transcript. */
  olderBefore: string | null;
  /** The newest entry id of the transcript when it was read, which live top-ups ask for entries after. */
  lastId: string | null;
  /** Whether more entries are waiting after this page, for a read with `after`. */
  more: boolean;
}

export type ConversationItem =
  | { type: "message"; key: string; at: string; message: ThreadMessage }
  | { type: "entry"; key: string; at: string; entry: TranscriptEntryView };

function byId(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function idOf(item: ConversationItem): string {
  return item.type === "message" ? item.message.id : item.entry.id;
}

/** By time; at the same instant a message comes before a transcript entry, since the agent reads it first. */
function byTime(left: ConversationItem, right: ConversationItem): number {
  return byCodePoint(left.at, right.at) || byCodePoint(right.type, left.type) || byId(idOf(left), idOf(right));
}

/**
 * The messages and entries in time order. A user entry that records a direct message the page already shows is the
 * agent receiving that message, so the message stands for both rather than appearing twice.
 */
export function conversationItems(messages: readonly ThreadMessage[], entries: readonly TranscriptEntryView[]): ConversationItem[] {
  const shown = new Set(messages.map((message) => message.id));
  const items: ConversationItem[] = [
    ...messages.map((message): ConversationItem => ({ type: "message", key: `m${message.id}`, at: message.created_at, message })),
    ...entries
      .filter((entry) => !(entry.role === "user" && entry.message_id !== null && shown.has(entry.message_id)))
      .map((entry): ConversationItem => ({ type: "entry", key: `t${entry.id}`, at: entry.occurred_at, entry }))
  ];
  return items.sort(byTime);
}

/** Every entry in either list once, in time order. Entries never change, so which copy is kept does not matter. */
export function mergeEntries(existing: readonly TranscriptEntryView[], incoming: readonly TranscriptEntryView[]): TranscriptEntryView[] {
  const byKey = new Map<string, TranscriptEntryView>();
  for (const entry of [...existing, ...incoming]) {
    byKey.set(entry.id, entry);
  }
  return [...byKey.values()].sort((left, right) => byCodePoint(left.occurred_at, right.occurred_at) || byId(left.id, right.id));
}

/** The larger of two entry ids, either of which may be missing. */
export function newerId(left: string | null, right: string | null): string | null {
  if (left === null || right === null) {
    return left ?? right;
  }
  return byId(left, right) >= 0 ? left : right;
}

const SUMMARY_LENGTH = 120;

/** The input fields that say what a tool call did, most telling first, as Claude Code's tools name them. */
const SUMMARY_FIELDS = ["description", "command", "file_path", "path", "pattern", "url", "query", "prompt"];

/** `text` on one line, cut to `max` characters. */
export function oneLine(text: string, max: number = SUMMARY_LENGTH): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A tool call's input in one line: its most telling field when it has one, its JSON otherwise. */
export function toolSummary(input: unknown): string {
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input === "string") {
    return oneLine(input);
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    const fields = input as Record<string, unknown>;
    const telling = SUMMARY_FIELDS.map((field) => fields[field]).find((value) => typeof value === "string" && value.trim() !== "");
    if (typeof telling === "string") {
      return oneLine(telling);
    }
  }
  return oneLine(JSON.stringify(input));
}
