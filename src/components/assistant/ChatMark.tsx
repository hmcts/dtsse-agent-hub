"use client";

import type { ConversationMark, SidebarKind } from "@/assistant/views";
import { useLiveLocalSession } from "@/components/assistant/LiveLocalSessions";
import { LocalMark } from "@/components/assistant/LocalMark";
import { PodMark } from "@/components/assistant/PodMark";
import { SessionMark } from "@/components/assistant/SessionMark";
import { FeedbackIcon } from "@/components/sidebar/icons";

/** What `ChatMark` reads of a sidebar row or a search result. */
export type MarkedItem = { kind: Exclude<SidebarKind, "feedback">; id: string; mark: ConversationMark } | { kind: "feedback"; id: string; marked: boolean };

/**
 * The mark beside an item's title, wherever the person's sidebar items are listed: the grouped list and the results
 * of its search.
 *
 * One component for both, because the two lists showing the same item differently is the fault this is here to
 * prevent. Whether to mark is decided on the server (`showsMarks`); all that is left here is which component says it.
 * A local chat's session follows its live status where one holds (`LiveLocalSessions`).
 */
export function ChatMark({ item }: { item: MarkedItem }) {
  const live = useLiveLocalSession(item.id);
  if (item.kind === "feedback") {
    return item.marked ? <SessionMark words="Feedback project" colour="text-asst-muted" working={false} icon={<FeedbackIcon />} /> : null;
  }
  if (item.mark === null) {
    return null;
  }
  return item.mark.where === "computer" ? <LocalMark session={live ?? item.mark.session} /> : <PodMark session={item.mark.session} />;
}
