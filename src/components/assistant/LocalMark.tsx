import type { LocalSession } from "@/assistant/local-session";
import { SessionMark } from "@/components/assistant/SessionMark";
import { LaptopIcon } from "@/components/sidebar/icons";

/**
 * What each of the three states is called, and the colour the icon carries it in.
 *
 * The words are the whole of the state for anyone the colour does not reach, which is why they name it rather than
 * only saying where the chat runs: colour is never the only thing carrying it (WCAG 1.4.1). The tokens are the
 * Assistant theme's own, so the mark is legible in the light theme as well as the dark one. `working` is `ready`'s
 * green with `SessionMark`'s badge, because both are a connected session and the badge says it is mid-turn.
 * `asst-faint` for a session that is not connected is the colour the rest of the row's secondary text is already in.
 */
const SESSION: Record<LocalSession, { words: string; colour: string }> = {
  ready: { words: "On your computer, ready", colour: "text-asst-ok" },
  working: { words: "On your computer, working", colour: "text-asst-ok" },
  disconnected: { words: "On your computer, not connected", colour: "text-asst-faint" }
};

/**
 * That a chat is a Claude Code session on the person's own computer rather than one running on their assistant, and
 * which of the three states that session is in.
 *
 * The icon is the repo's own, from `components/sidebar/icons`, and it is not the whole of the marker: the words are
 * beside it for a screen reader, because what a small laptop outline is supposed to mean is knowable only to whoever
 * put it there. They lead the row's name — "On your computer, idle: Reviewing the claim form" — so the one thing
 * about the chat that is not in its title is the first thing read out. The tooltip says the same to a pointer.
 *
 * Its own module rather than another export of `AssistantShell`, which both of the lists that show it already
 * import: the sidebar's own list is in that file and the search's results are in `ConversationSearch`, which the
 * shell renders, so a marker living in the shell would have the two importing each other.
 */
export function LocalMark({ session }: { session: LocalSession }) {
  const { words, colour } = SESSION[session];
  return <SessionMark words={words} colour={colour} working={session === "working"} icon={<LaptopIcon />} />;
}
