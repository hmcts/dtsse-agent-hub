"use client";

import { useEffect, useState } from "react";
import type { AgentAccess } from "@/access/rules";
import { EmptyState } from "@/components/EmptyState";
import { useHubEvent, useWatch } from "@/components/live/HubStream";
import type { DeliveryView, ThreadMessage } from "@/messages/direct-thread";
import { mergeMessages } from "@/messages/pagination";
import type { ActionResult } from "@/web/action";
import { instant } from "@/web/format";

export type SendAction = (input: { agentId: string; body: string }) => Promise<ActionResult<{ message: ThreadMessage }>>;

const DELIVERY_STYLE: Record<DeliveryView, string> = {
  queued: "border-amber-700 text-amber-300",
  delivered: "border-green-800 text-green-300",
  expired: "border-slate-600 text-slate-300"
};

/** Only an owner or a write grantee may message an agent; `canPersonMessageAgent` decides the same on the server. */
export function mayMessage(access: Exclude<AgentAccess, "none">): boolean {
  return access === "owner" || access === "write";
}

function DeliveryBadge({ state }: { state: DeliveryView }) {
  return <span className={`rounded border px-1 text-[11px] uppercase tracking-wide ${DELIVERY_STYLE[state]}`}>{state}</span>;
}

function ThreadEntry({ agentId, message }: { agentId: string; message: ThreadMessage }) {
  const fromAgent = message.author.agent_id === agentId;
  const who = message.author.agent_name === null ? message.author.owner_name : `@${message.author.agent_name} (${message.author.owner_name})`;
  return (
    <li className={`rounded-lg border p-3 ${fromAgent ? "border-slate-800 bg-slate-900" : "border-indigo-900 bg-indigo-950/40"}`} data-message-id={message.id}>
      <p className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span className="font-semibold text-slate-200">{who}</span>
        <span>{fromAgent ? (message.target_agent_id === null ? "replied" : "sent") : "to this agent"}</span>
        <time dateTime={message.created_at}>{instant(message.created_at)}</time>
        <span>#{message.id}</span>
        {message.delivery !== null ? <DeliveryBadge state={message.delivery} /> : null}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-200">{message.body}</p>
    </li>
  );
}

/**
 * An agent's direct-message thread, both directions, updated live. The composer appears only with write access; a
 * person with read access sees why it is missing.
 */
export function DirectThread({
  agentId,
  access,
  initial,
  send
}: {
  agentId: string;
  access: Exclude<AgentAccess, "none">;
  initial: ThreadMessage[];
  send: SendAction;
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>(initial);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useWatch([], "any", agentId);

  useEffect(() => {
    setMessages((current) => mergeMessages(current, initial));
  }, [initial]);

  useHubEvent<{ message: ThreadMessage }>("direct", ({ message }) => {
    setMessages((current) => mergeMessages(current, [message]));
  });

  useHubEvent<{ message_id: string; state: DeliveryView }>("delivery", ({ message_id, state }) => {
    setMessages((current) => current.map((message) => (message.id === message_id ? { ...message, delivery: state } : message)));
  });

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
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
      setError("the message could not be sent; check your connection and try again");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      {messages.length === 0 ? (
        <EmptyState message="No direct messages with this agent yet." />
      ) : (
        <ol className="space-y-2" aria-label="Direct messages" aria-live="polite">
          {messages.map((message) => (
            <ThreadEntry key={message.id} agentId={agentId} message={message} />
          ))}
        </ol>
      )}
      {mayMessage(access) ? (
        <form onSubmit={submit} className="space-y-2" aria-label="Message this agent">
          <label className="block">
            <span className="text-sm text-slate-300">Message this agent</span>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              required
              rows={3}
              maxLength={32_000}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={pending || body.trim() === ""}
              className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
            >
              {pending ? "Sending" : "Send"}
            </button>
            {error ? (
              <span role="alert" className="text-xs text-red-300">
                {error}
              </span>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="text-xs text-slate-400" data-testid="read-only-thread">
          You have read access to this agent. Its owner can grant you write access to message it.
        </p>
      )}
    </div>
  );
}
