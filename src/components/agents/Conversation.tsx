"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentAccess } from "@/access/rules";
import { DirectComposer, type SendAction } from "@/components/agents/DirectComposer";
import { DirectMessage, senderName } from "@/components/agents/DirectMessage";
import { TranscriptEntry } from "@/components/agents/TranscriptEntry";
import { EmptyState } from "@/components/EmptyState";
import { useStickToBottom } from "@/components/feed/useStickToBottom";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { useEndSession, useHubEvent, useWatch } from "@/components/live/HubStream";
import { SessionEndedMessage } from "@/components/live/SessionEnded";
import type { DeliveryView, ThreadMessage } from "@/messages/direct-thread";
import { mergeMessages } from "@/messages/pagination";
import type { AgentStatus } from "@/realtime/events";
import { type ConversationPage, conversationItems, mergeEntries, newerId } from "@/transcripts/conversation";

export function transcriptUrl(agentId: string, cursor: { before: string } | { after: string }): string {
  return `/api/ui/agents/${encodeURIComponent(agentId)}/transcript?${new URLSearchParams(cursor).toString()}`;
}

/** Whether `id` is past `last`, which is `null` before the transcript has any entries. */
function isPast(id: string, last: string | null): boolean {
  return last === null || BigInt(id) > BigInt(last);
}

class SignedOut extends Error {}

/**
 * An agent's conversation, updated live: the direct messages to and from it and its session's transcript, in time
 * order. A `transcript` event names the newest entry, and the entries after the newest shown are read then; earlier
 * entries are read a page at a time above. The composer appears only with write access.
 */
export function Conversation({
  agentId,
  agentName,
  ownerName,
  status,
  access,
  initial,
  send
}: {
  agentId: string;
  agentName: string;
  ownerName: string;
  status: AgentStatus;
  access: Exclude<AgentAccess, "none">;
  initial: ConversationPage;
  send: SendAction;
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>(initial.messages);
  const [entries, setEntries] = useState(initial.entries);
  const [olderBefore, setOlderBefore] = useState<string | null>(initial.olderBefore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const lastId = useRef<string | null>(initial.lastId);
  const wanted = useRef<string | null>(null);
  const reading = useRef(false);
  const items = conversationItems(messages, entries);
  const scroller = useStickToBottom<HTMLDivElement>(items.length);
  const endSession = useEndSession();
  const arrivals = useAnnouncer("messages");

  useWatch([], "any", agentId);

  // A server re-render (after a resync) hands down a fresh newest page; merge it rather than lose earlier pages.
  useEffect(() => {
    setMessages((current) => mergeMessages(current, initial.messages));
    setEntries((current) => mergeEntries(current, initial.entries));
    lastId.current = newerId(lastId.current, initial.lastId);
  }, [initial]);

  async function read(cursor: { before: string } | { after: string }): Promise<ConversationPage> {
    const response = await fetch(transcriptUrl(agentId, cursor), { headers: { accept: "application/json" } });
    if (response.status === 401) {
      setSignedOut(true);
      endSession();
      throw new SignedOut();
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as ConversationPage;
  }

  /** Reads entries until the newest one announced is shown. One read at a time; a later event extends the current one. */
  async function topUp(): Promise<void> {
    if (reading.current) {
      return;
    }
    reading.current = true;
    try {
      while (wanted.current !== null && isPast(wanted.current, lastId.current)) {
        const page = await read({ after: lastId.current ?? "0" });
        if (page.entries.some((entry) => entry.role === "assistant")) {
          arrivals.announce(`New reply from @${agentName}`);
        }
        setEntries((current) => mergeEntries(current, page.entries));
        lastId.current = newerId(lastId.current, page.lastId);
        // The announced entry may already have been swept, so an empty read ends the catch-up rather than repeating.
        if (page.entries.length === 0) {
          break;
        }
      }
    } catch {
      // Left for the next event, or the resync after a reconnect, to read again.
    } finally {
      reading.current = false;
    }
  }

  useHubEvent<{ agent_id: string; last_id: string }>("transcript", ({ agent_id, last_id }) => {
    if (agent_id !== agentId) {
      return;
    }
    wanted.current = newerId(wanted.current, last_id);
    void topUp();
  });

  useHubEvent<{ message: ThreadMessage }>("direct", ({ message }) => {
    if (!messages.some((shown) => shown.id === message.id)) {
      arrivals.announce(`New message from ${senderName(message)}`);
    }
    setMessages((current) => mergeMessages(current, [message]));
  });

  useHubEvent<{ message_id: string; state: DeliveryView }>("delivery", ({ message_id, state }) => {
    setMessages((current) => current.map((message) => (message.id === message_id ? { ...message, delivery: state } : message)));
  });

  async function loadEarlier(): Promise<void> {
    if (olderBefore === null) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const page = await read({ before: olderBefore });
      setMessages((current) => mergeMessages(page.messages, current));
      setEntries((current) => mergeEntries(page.entries, current));
      setOlderBefore(page.olderBefore);
    } catch (failure) {
      if (!(failure instanceof SignedOut)) {
        setError("earlier activity could not be loaded; try again");
      }
    } finally {
      setLoading(false);
    }
  }

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
          status={status}
          access={access}
          send={send}
          onSent={(message) => setMessages((current) => mergeMessages(current, [message]))}
        />
      </div>
    </div>
  );
}
