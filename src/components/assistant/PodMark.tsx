import { CloudIcon } from "@/components/sidebar/icons";

/**
 * That a chat runs on the person's assistant rather than on their own computer — the other half of `LocalMark`, and
 * shown only once they have a local chat for it to tell this one apart from. `ConversationMark` is where that is
 * decided; a list with nothing but pod chats in it carries no marks at all, because a cloud against every row of it
 * would distinguish them from nothing.
 *
 * Carries no state, deliberately, and will not be coloured. The laptop's colour answers "is my computer connected",
 * which is a question with one answer the person can act on. A pod has no equivalent: what it has is a lifecycle of
 * its own and a session's on top of it — starting, queued, being swept, stopped — and flattening that onto three
 * traffic lights beside a chat title would invent a meaning the states do not have. Where a pod chat stands is said
 * in words on the chat's own page, which has the room to say it properly.
 */
export function PodMark() {
  return (
    <span className="flex shrink-0 items-center text-asst-faint" title="On your assistant">
      {/* The icon is decorative and the words carry the mark, as in `LocalMark`; the trailing space joins them to
          the title that follows. */}
      <CloudIcon />
      <span className="sr-only">{"On your assistant: "}</span>
    </span>
  );
}
