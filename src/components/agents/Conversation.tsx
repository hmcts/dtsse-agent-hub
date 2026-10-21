"use client";

import { useRouter } from "next/navigation";
import type { AgentAccess } from "@/access/rules";
import type { Skill } from "@/agents/skills";
import { DirectComposer, type SendAction } from "@/components/agents/DirectComposer";
import { DirectMessage, senderName } from "@/components/agents/DirectMessage";
import { TranscriptEntry } from "@/components/agents/TranscriptEntry";
import { useLiveConversation } from "@/components/agents/useLiveConversation";
import { EmptyState } from "@/components/EmptyState";
import { useStickToBottom } from "@/components/feed/useStickToBottom";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { useHubEvent } from "@/components/live/HubStream";
import { SessionEndedMessage } from "@/components/live/SessionEnded";
import type { AgentStatus } from "@/realtime/events";
import type { ConversationPage } from "@/transcripts/conversation";

export { transcriptUrl } from "@/components/agents/useLiveConversation";

/**
 * An agent's conversation, updated live: the direct messages to and from it and its session's transcript, in time
 * order. A `transcript` event names the newest entry, and the entries after the newest shown are read then; earlier
 * entries are read a page at a time above. The composer appears only with write access. An `agent_skills` event
 * re-reads the page, since it carries only the id, so the composer's "/" autocomplete offers the agent's new skills.
 */
export function Conversation({
  agentId,
  agentName,
  ownerName,
  virtualAgentId = null,
  viewerOid,
  status,
  access,
  initial,
  skills = [],
  send
}: {
  agentId: string;
  agentName: string;
  ownerName: string;
  /** The virtual agent whose session this agent is, or `null` for a session on a laptop. */
  virtualAgentId?: string | null;
  /** Who is reading, which the composer keys its draft on. */
  viewerOid: string;
  status: AgentStatus;
  access: Exclude<AgentAccess, "none">;
  initial: ConversationPage;
  /** What the composer's "/" autocomplete offers. */
  skills?: readonly Skill[];
  send: SendAction;
}) {
  const arrivals = useAnnouncer("messages");
  const router = useRouter();
  const { items, olderBefore, loading, error, signedOut, loadEarlier, addMessage } = useLiveConversation(agentId, initial, {
    onReply: () => arrivals.announce(`New reply from @${agentName}`),
    onMessage: (message) => arrivals.announce(`New message from ${senderName(message)}`)
  });
  const scroller = useStickToBottom<HTMLDivElement>(items.length);

  useHubEvent<{ agent_id: string }>("agent_skills", ({ agent_id }) => {
    if (agent_id === agentId) {
      router.refresh();
    }
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller.ref} onScroll={scroller.onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col justify-end py-4">
          {olderBefore !== null ? (
            <div className="flex items-center justify-center gap-3 pb-4">
              <button
                type="button"
                onClick={loadEarlier}
                disabled={loading}
                className="rounded-full border border-hub-line px-3 py-1 text-[13px] text-hub-text hover:bg-hub-raised disabled:text-hub-muted"
              >
                {loading ? "Loading" : "Load earlier"}
              </button>
              {signedOut ? (
                <span role="status" className="text-xs text-red-300">
                  <SessionEndedMessage />
                </span>
              ) : error ? (
                <span role="alert" className="text-xs text-red-300">
                  {error}
                </span>
              ) : null}
            </div>
          ) : null}
          {items.length === 0 ? (
            <div className="px-5">
              <EmptyState message="Nothing in this agent's conversation yet." detail="Direct messages and its session's activity appear here." />
            </div>
          ) : (
            <ol aria-label="Conversation">
              {items.map((item) =>
                item.type === "message" ? (
                  <DirectMessage key={item.key} agentId={agentId} message={item.message} />
                ) : (
                  <TranscriptEntry key={item.key} entry={item.entry} agentName={agentName} ownerName={ownerName} />
                )
              )}
            </ol>
          )}
        </div>
        <AnnouncerRegion text={arrivals.text} />
      </div>
      <div className="shrink-0 px-5 pb-5">
        <DirectComposer
          agentId={agentId}
          agentName={agentName}
          virtualAgentId={virtualAgentId}
          viewerOid={viewerOid}
          status={status}
          access={access}
          skills={skills}
          send={send}
          onSent={addMessage}
        />
      </div>
    </div>
  );
}
