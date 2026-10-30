import type { PodSession } from "@/assistant/views";
import { CloudIcon } from "@/components/sidebar/icons";

/**
 * What each of the four states is called, and the colour the icon carries it in.
 *
 * As in `LocalMark`, the words are the whole of the state for anyone the colour does not reach (WCAG 1.4.1), and the
 * colours are the Assistant theme's own tokens. `ready` and `working` are coloured as the laptop's are. `starting`
 * shares `working`'s amber — a session on its way, whether the pod is starting it or it is waiting for a slot — and
 * is told apart from it by its words; `disconnected` is the faint colour of the row's secondary text.
 */
const SESSION: Record<PodSession, { words: string; colour: string }> = {
  ready: { words: "On your assistant, ready", colour: "text-asst-ok" },
  working: { words: "On your assistant, working", colour: "text-asst-warn" },
  starting: { words: "On your assistant, starting", colour: "text-asst-warn" },
  disconnected: { words: "On your assistant, not connected", colour: "text-asst-faint" }
};

/**
 * That a chat runs on the person's assistant rather than on their own computer — the other half of `LocalMark`, and
 * shown only once they have a local chat for it to tell this one apart from. `ConversationMark` is where that is
 * decided; a list with nothing but pod chats in it carries no marks at all, because a cloud against every row of it
 * would distinguish them from nothing.
 *
 * Coloured by whether the chat has an agent session connected, which is what `podSessionOf` works out. The pod's own
 * lifecycle has more states than that (queued, being swept, stopped) and they are folded into these four; the chat's
 * own page has the room to say the rest.
 */
export function PodMark({ session }: { session: PodSession }) {
  const { words, colour } = SESSION[session];
  return (
    <span className={`flex shrink-0 items-center ${colour}`} title={words}>
      {/* The icon is decorative and the words carry the mark, as in `LocalMark`; the trailing space joins them to
          the title that follows. */}
      <CloudIcon />
      <span className="sr-only">{`${words}: `}</span>
    </span>
  );
}
