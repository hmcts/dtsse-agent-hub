import type { ConversationMark } from "@/assistant/views";
import { LocalMark } from "@/components/assistant/LocalMark";
import { PodMark } from "@/components/assistant/PodMark";

/**
 * The mark beside a chat's title, wherever one of the person's own chats is listed: the sidebar's grouped list and
 * the results of its search.
 *
 * One component for both, rather than the same choice written out twice, because the two lists showing the same
 * chat differently is the fault this is here to prevent — the search's results once carried no mark at all while
 * the rows below them did. What to mark is `ConversationMark`'s, decided on the server; all that is left here is
 * which component says it.
 */
export function ChatMark({ mark }: { mark: ConversationMark }) {
  if (mark === null) {
    return null;
  }
  return mark.where === "computer" ? <LocalMark session={mark.session} /> : <PodMark session={mark.session} />;
}
