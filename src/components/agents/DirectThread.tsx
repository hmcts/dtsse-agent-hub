"use client";

import { useEffect, useId, useState } from "react";
import type { AgentAccess } from "@/access/rules";
import { EXPIRE_AFTER_SECONDS } from "@/agents/liveness";
import { Avatar } from "@/components/Avatar";
import { useLiveStatus } from "@/components/agents/LiveStatus";
import { EmptyState } from "@/components/EmptyState";
import { SEND_BUTTON, submitOnEnter } from "@/components/feed/Composer";
import { MessageBody } from "@/components/feed/MessageBody";
import { BYLINE_ID, MessageLink } from "@/components/feed/MessageLink";
import { useStickToBottom } from "@/components/feed/useStickToBottom";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { useEndSession, useHubEvent, useWatch } from "@/components/live/HubStream";
import { SessionEndedMessage } from "@/components/live/SessionEnded";
import { sessionEnded } from "@/components/live/session";
import { SendIcon } from "@/components/sidebar/icons";
import { Timestamp } from "@/components/time/Timestamp";
import type { DeliveryView, ThreadMessage } from "@/messages/direct-thread";
import { mergeMessages } from "@/messages/pagination";
import type { AgentStatus } from "@/realtime/events";
import type { ActionResult } from "@/web/action";
import { duration } from "@/web/format";

export type SendAction = (input: { agentId: string; body: string }) => Promise<ActionResult<{ message: ThreadMessage }>>;

const DELIVERY_STYLE: Record<DeliveryView, string> = {
  queued: "border-amber-700 text-amber-300",
  delivered: "border-green-800 text-green-300",
  expired: "border-hub-line text-hub-muted"
};

/** Only an owner or a write grantee may message an agent; `canPersonMessageAgent` decides the same on the server. */
export function mayMessage(access: Exclude<AgentAccess, "none">): boolean {
  return access === "owner" || access === "write";
}

/** Why a message to an offline agent is not lost, and how long it is kept. */
export function offlineNote(agentName: string | undefined): string {
  const who = agentName ? `@${agentName}` : "This agent";
  return `${who} is offline; your message is queued and delivered when it reconnects. Queued messages expire after ${duration(EXPIRE_AFTER_SECONDS)} offline.`;
}

function senderName(message: ThreadMessage): string {
  return message.author.agent_name === null ? message.author.owner_name : `@${message.author.agent_name}`;
}

function DeliveryBadge({ state }: { state: DeliveryView }) {
  return <span className={`rounded border px-1 text-[11px] uppercase tracking-wide ${DELIVERY_STYLE[state]}`}>{state}</span>;
}

function ThreadEntry({ agentId, message }: { agentId: string; message: ThreadMessage }) {
  const fromAgent = message.author.agent_id === agentId;
  const name = senderName(message);
  return (
    <li className="flex gap-2 px-5 py-2 hover:bg-hub-raised" data-message-id={message.id}>
      <Avatar name={name} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 leading-5">
          <span className="text-[15px] font-bold text-white">{name}</span>
          {message.author.agent_name === null ? null : <span className="text-xs text-hub-muted">({message.author.owner_name})</span>}
          <span className="text-xs text-hub-muted">{fromAgent ? (message.target_agent_id === null ? "replied" : "sent") : "to this agent"}</span>
          <Timestamp iso={message.created_at} className="text-xs text-hub-muted" />
          <MessageLink id={message.id} className={BYLINE_ID} />
          {message.delivery !== null ? <DeliveryBadge state={message.delivery} /> : null}
        </p>
        <MessageBody body={message.body} />
      </div>
    </li>
  );
}

/**
 * An agent's direct-message thread, both directions, updated live. The composer appears only with write access; a
 * person with read access sees why it is missing.
 */
export function DirectThread({
  agentId,
  agentName,
  status: initialStatus,
  access,
  initial,
  send
}: {
  agentId: string;
  agentName?: string;
  status: AgentStatus;
  access: Exclude<AgentAccess, "none">;
  initial: ThreadMessage[];
  send: SendAction;
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>(initial);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const scroller = useStickToBottom<HTMLDivElement>(messages);
  const endSession = useEndSession();
  const [signedOut, setSignedOut] = useState(false);
  const status = useLiveStatus(agentId, initialStatus);
  const arrivals = useAnnouncer("messages");
  const noteId = useId();

  useWatch([], "any", agentId);

  useEffect(() => {
    setMessages((current) => mergeMessages(current, initial));
  }, [initial]);

  useHubEvent<{ message: ThreadMessage }>("direct", ({ message }) => {
    if (!messages.some((shown) => shown.id === message.id)) {
      arrivals.announce(`New message from ${senderName(message)}`);
    }
    setMessages((current) => mergeMessages(current, [message]));
  });

  useHubEvent<{ message_id: string; state: DeliveryView }>("delivery", ({ message_id, state }) => {
    setMessages((current) => current.map((message) => (message.id === message_id ? { ...message, delivery: state } : message)));
  });

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || body.trim() === "") {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await send({ agentId, body });
      if (result.ok) {
        setBody("");
        setMessages((current) => mergeMessages(current, [result.message]));
      } else {
        setError(result.error);
      }
    } catch {
      if (await sessionEnded()) {
        setSignedOut(true);
        endSession();
      } else {
        setError("the message could not be sent; check your connection and try again");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller.ref} onScroll={scroller.onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col justify-end py-4">
          {messages.length === 0 ? (
            <div className="px-5">
              <EmptyState message="No direct messages with this agent yet." />
            </div>
          ) : (
            <ol aria-label="Direct messages">
              {messages.map((message) => (
                <ThreadEntry key={message.id} agentId={agentId} message={message} />
              ))}
            </ol>
          )}
        </div>
        <AnnouncerRegion text={arrivals.text} />
      </div>
      <div className="shrink-0 px-5 pb-5">
        {mayMessage(access) ? (
          <form onSubmit={submit} className="rounded-lg border border-hub-line bg-hub-pane focus-within:border-hub-muted" aria-label="Message this agent">
            {status === "offline" ? (
              <p id={noteId} className="rounded-t-lg bg-hub-raised px-3 py-1.5 text-xs text-amber-300">
                {offlineNote(agentName)}
              </p>
            ) : null}
            <label className="block">
              <span className="sr-only">Message this agent</span>
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={submitOnEnter}
                aria-describedby={status === "offline" ? noteId : undefined}
                required
                rows={2}
                maxLength={32_000}
                placeholder={agentName ? `Message @${agentName}` : "Message this agent"}
                className="block max-h-60 w-full resize-y bg-transparent px-3 pt-2.5 pb-1 text-[15px] text-hub-text placeholder:text-hub-muted focus:outline-none"
              />
            </label>
            <div className="flex items-center gap-3 px-2 pb-2">
              <span className="text-xs text-hub-muted">Enter to send, Shift+Enter for a new line</span>
              {signedOut ? (
                <span role="status" className="text-xs text-red-300">
                  <SessionEndedMessage />
                </span>
              ) : error ? (
                <span role="alert" className="text-xs text-red-300">
                  {error}
                </span>
              ) : null}
              <button type="submit" disabled={pending || body.trim() === ""} className={`ml-auto ${SEND_BUTTON}`}>
                <SendIcon />
                <span className="sr-only">{pending ? "Sending" : "Send"}</span>
              </button>
            </div>
          </form>
        ) : (
          <p className="rounded-lg border border-hub-line px-3 py-3 text-[13px] text-hub-muted" data-testid="read-only-thread">
            You have read access to this agent. Its owner can grant you write access to message it.
          </p>
        )}
      </div>
    </div>
  );
}
