import type { PodSession } from "@/assistant/views";
import { SessionMark } from "@/components/assistant/SessionMark";
import { CloudIcon } from "@/components/sidebar/icons";

/**
 * What each of the four states is called, and the colour the icon carries it in.
 *
 * As in `LocalMark`, the words are the whole of the state for anyone the colour does not reach (WCAG 1.4.1), and the
 * colours are the Assistant theme's own tokens. `ready` and `working` are coloured as the laptop's are, `working`
 * carrying `SessionMark`'s badge. `starting` is a solid amber with no badge — a session on its way, whether the pod is
 * starting it or it is waiting for a slot — so it reads as neither connected nor working; `disconnected` is the faint
 * colour of the row's secondary text.
 */
const SESSION: Record<PodSession, { words: string; colour: string }> = {
  ready: { words: "On your assistant, ready", colour: "text-asst-ok" },
  working: { words: "On your assistant, working", colour: "text-asst-ok" },
  starting: { words: "On your assistant, starting", colour: "text-asst-warn" },
  disconnected: { words: "On your assistant, not connected", colour: "text-asst-faint" }
};

/**
 * That a chat runs on the person's assistant rather than on their own computer — the other half of `LocalMark`, and
 * shown only once their list holds another kind of item for it to tell this one apart from (`showsMarks`).
 *
 * Coloured by whether the chat has an agent session connected, which is what `podSessionOf` works out. The pod's own
 * lifecycle has more states than that (queued, being swept, stopped) and they are folded into these four; the chat's
 * own page has the room to say the rest.
 */
export function PodMark({ session }: { session: PodSession }) {
  const { words, colour } = SESSION[session];
  return <SessionMark words={words} colour={colour} working={session === "working"} icon={<CloudIcon />} />;
}
