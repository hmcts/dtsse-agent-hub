import { collapse } from "../transcripts/conversation.ts";
import { isHarnessTurn } from "../transcripts/harness-turn.ts";

/**
 * What a conversation is called: the lengths a title may be, the three things that can name one, and the rules for
 * reading a name out of what was said in a chat.
 *
 * Pure, so every rule here is unit-tested; `store.ts` holds the reads and writes that apply them.
 */

/** A new conversation's title is the start of its first message, until the person renames it. */
export const TITLE_FROM_MESSAGE = 60;

/** The longest title a conversation can carry, whoever wrote it: the person renaming it, or a local session's name. */
export const TITLE_MAX = 200;

/**
 * Which of the three things that can name a conversation named this one, weakest first:
 *
 * - `agent` — the name a local session's client reported. A placeholder as often as not: the client derives it from
 *   the transcript's own title and falls back to the session registry's handle, `hmcts-25`, while it has nothing
 *   better, which it has not when the session registers and its chat is made.
 * - `message` — the first thing said in the chat. The person's first message for a chat on a pod, their first prompt
 *   for one on their own computer, which is what that chat is about. It is also what a title from before this column
 *   existed is read as when the one-off that added it could not attribute the title, because the rules for the two
 *   are the same: nothing automatic replaces either, and a `/rename` replaces both.
 * - `user` — the person named it themselves, in the hub. Nothing overwrites it.
 *
 * Kept on the row rather than worked out from the title, because a refresh that could not tell an automatic title
 * from a chosen one would rename a chat out from under the person who named it.
 */
export type TitleSource = "agent" | "message" | "user";

/**
 * The title to store for a name a local session's client reported: normalised exactly as a rename is, so the two
 * cannot disagree about what a title may be.
 *
 * Kept even when the client had nothing better and sent the first characters of the session id. That reads as
 * nothing, but it is what the hub calls the same session everywhere else, and the alternative is a sidebar in which
 * every laptop says "New chat"; the first prompt replaces it as soon as one arrives.
 */
export function localTitle(name: string): string | null {
  return collapse(name).slice(0, TITLE_MAX) || null;
}

/** The title to store for the first thing said in a chat, whether the person typed it into the hub or their terminal. */
export function messageTitle(text: string): string | null {
  return collapse(text).slice(0, TITLE_FROM_MESSAGE) || null;
}

/**
 * How many of a chat's earliest prompts are read when looking for one to name it after. More than one, because the
 * first can be redacted or a relayed message; a handful rather than all of them, because this is read on the
 * transcript upload path and a chat whose opening prompts are all unusable keeps the name its session reported,
 * which is a title, rather than costing a scan of every prompt it has. Ten, because a `/clear` alone writes three
 * harness turns before the person has said anything.
 */
export const PROMPT_CANDIDATES = 10;

/** One `role = 'user'` transcript entry, as much of it as naming a chat depends on. */
export interface PromptEntry {
  content: unknown;
  redacted: boolean;
  /** Set when the entry is a hub message relayed into the session rather than something the person typed there. */
  messageId: bigint | null;
}

/**
 * The title a local chat takes from its own prompts: the first of them with words in it, cut as a pod chat's first
 * message is, or null when none of the entries offered can name a chat.
 *
 * Four kinds are passed over rather than used:
 *
 * - **A redacted prompt.** The secret scanner replaced its text with the pattern it matched, so there is nothing
 *   left to name the chat after — and "redacted" is not a title.
 * - **A prompt that is a relayed hub message** (`messageId`). It is a colleague's words, or an answer to a question
 *   the session asked, delivered into the session by the bridge; the chat is not about it.
 * - **A turn the harness wrote** (`isHarnessTurn`): a slash command's record, its output, or a background task's
 *   notification. Nobody typed it, and it named half of a sidebar `<command-name>/clear</command-name>…`.
 * - **A prompt that is whitespace, or whose content is not the `{text}` of an ordinary entry.** The second cannot
 *   happen through `POST /api/agent/{agent_id}/transcript`, which checks the shape against the role, and is still
 *   read for: `content` is jsonb and this is the only thing that reads it as a title.
 *
 * `truncated` is not one of them. A truncated prompt is the start of what the person typed, and the start is all a
 * title takes anyway.
 */
export function firstPromptTitle(entries: readonly PromptEntry[]): string | null {
  for (const entry of entries) {
    if (entry.redacted || entry.messageId !== null) {
      continue;
    }
    const text = (entry.content as { text?: unknown } | null)?.text;
    const title = typeof text === "string" && !isHarnessTurn(text) ? messageTitle(text) : null;
    if (title !== null) {
      return title;
    }
  }
  return null;
}
