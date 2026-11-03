/**
 * Where the name a session reports came from, which is the one thing that separates a handle the client invented
 * from one the person chose.
 *
 * The client derives a session's name from the transcript's conversation title and falls back to the session
 * registry's handle while it has nothing better, so most names arriving here are automatic. A `/rename` is not: it
 * is the person saying what this session is, and `agentName` in the client treats it as the last word. The hub
 * cannot tell the two apart by looking — `hmcts-25` and `hdpi-9653-welsh` are both names on the same column — so
 * the client says, and this is what it says with.
 *
 * Nothing about an agent turns on it except the title of a chat on somebody's own computer, where it is what keeps
 * the person's own name for a session from being replaced by that session's first prompt.
 */

export type NameSource = "user" | "derived";

/**
 * What a reported or stored value means, which is `derived` for everything but a plain `user`.
 *
 * Tolerant on purpose, both ways round. On the wire, a client from before this field reports nothing and must
 * register exactly as it did, so absence cannot be an error; and Claude Code's registry has a third source of its
 * own, `auto`, for a name it generated from the conversation — automatic, so `derived` is the honest reading of it,
 * and a value this hub has never heard of is read the same way rather than refused. On the column, a row written
 * before the field existed says nothing, which is the same thing again.
 */
export function nameSourceOf(value: unknown): NameSource {
  return value === "user" ? "user" : "derived";
}
