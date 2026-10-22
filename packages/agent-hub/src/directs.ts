// The service keeps no history of an agent's direct messages, so the session keeps its own for the chat window.
// Everything here tolerates a half-written or garbage line: the file may have been appended to by an older
// version of this client, and a chat window that cannot be drawn must not take the session down with it.
import fs from "node:fs";
import { ensureStateDir, statePath } from "./session.ts";

const DIRECTS_FILE = "directs.jsonl";
const KEEP = 500;

export type DirectDirection = "in" | "out";

export type DirectPeer = {
  key: string;
  name: string;
};

// Structural, and every field optional: these are the parts of a message this file records, so anything matching
// `docs/agent-api.md` fits without this module importing the API client.
export type DirectAuthor = {
  type?: string;
  agent_id?: string | null;
  agent_name?: string | null;
  owner_name?: string | null;
  owner_email?: string | null;
};

export type DirectMessage = {
  id: string;
  body: string;
  in_reply_to?: string | null;
  created_at?: string;
  author?: DirectAuthor | null;
};

export type DirectEntry = {
  id: string;
  direction: DirectDirection;
  peer: DirectPeer;
  in_reply_to: string | null;
  created_at: string;
  author: DirectAuthor | null;
  body: string;
};

export type RecordDirectOptions = {
  direction: DirectDirection;
  peer: DirectPeer;
};

export function peerOf(author: DirectAuthor = {}): DirectPeer {
  if (author.type === "agent" && author.agent_id) {
    return { key: `agent:${author.agent_id}`, name: `@${author.agent_name}` };
  }
  return { key: `user:${author.owner_email || author.owner_name || "unknown"}`, name: author.owner_name || "unknown" };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asPeer(value: unknown): DirectPeer {
  const raw = asRecord(value);
  return { key: typeof raw?.key === "string" ? raw.key : "unknown", name: typeof raw?.name === "string" ? raw.name : "unknown" };
}

// Null for a line that is not an entry this module wrote. Every field is checked because the file is append-only
// and may hold lines from an older version of this client, or half a line from a process that died mid-write.
export function parseDirectEntry(value: unknown): DirectEntry | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.id !== "string" || typeof raw.body !== "string") {
    return null;
  }
  return {
    id: raw.id,
    direction: raw.direction === "out" ? "out" : "in",
    peer: asPeer(raw.peer),
    in_reply_to: typeof raw.in_reply_to === "string" ? raw.in_reply_to : null,
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    author: asRecord(raw.author) as DirectAuthor | null,
    body: raw.body
  };
}

export function readDirects(sid: string): DirectEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(statePath(sid, DIRECTS_FILE), "utf8");
  } catch {
    return [];
  }
  const out: DirectEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = parseDirectEntry(parsed);
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}

export function recordDirect(sid: string, message: DirectMessage, { direction, peer }: RecordDirectOptions): void {
  ensureStateDir(sid);
  const file = statePath(sid, DIRECTS_FILE);
  const entries = readDirects(sid);
  if (entries.some((d) => d.id === String(message.id))) {
    return;
  }
  const entry: DirectEntry = {
    id: String(message.id),
    direction,
    peer,
    in_reply_to: message.in_reply_to ?? null,
    created_at: message.created_at ?? new Date().toISOString(),
    author: message.author ?? null,
    body: message.body
  };
  if (entries.length >= KEEP) {
    const kept = [...entries.slice(-(KEEP - 1)), entry].map((d) => JSON.stringify(d)).join("\n");
    fs.writeFileSync(file, `${kept}\n`, { mode: 0o600 });
    return;
  }
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** The peer of an outgoing reply: whoever wrote the message it answers, as far as this session saw it. */
export function peerOfReply(sid: string, replyToId: string | number, fallback: DirectPeer | null): DirectPeer | null {
  const orig = readDirects(sid).find((d) => d.id === String(replyToId));
  return orig?.peer ?? fallback;
}
