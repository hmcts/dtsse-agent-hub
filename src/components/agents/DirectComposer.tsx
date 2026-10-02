"use client";

import { useId, useState } from "react";
import type { AgentAccess } from "@/access/rules";
import { EXPIRE_AFTER_SECONDS } from "@/agents/liveness";
import { useLiveStatus } from "@/components/agents/LiveStatus";
import { SEND_BUTTON, submitOnEnter } from "@/components/feed/Composer";
import { useEndSession } from "@/components/live/HubStream";
import { SessionEndedMessage } from "@/components/live/SessionEnded";
import { sessionEnded } from "@/components/live/session";
import { SendIcon } from "@/components/sidebar/icons";
import type { ThreadMessage } from "@/messages/direct-thread";
import type { AgentStatus } from "@/realtime/events";
import type { ActionResult } from "@/web/action";
import { duration } from "@/web/format";

export type SendAction = (input: { agentId: string; body: string }) => Promise<ActionResult<{ message: ThreadMessage }>>;

/** Only an owner or a write grantee may message an agent; `canPersonMessageAgent` decides the same on the server. */
export function mayMessage(access: Exclude<AgentAccess, "none">): boolean {
  return access === "owner" || access === "write";
}

/** Why a message to an offline agent is not lost, and how long it is kept. */
export function offlineNote(agentName: string | undefined): string {
  const who = agentName ? `@${agentName}` : "This agent";
  return `${who} is offline; your message is queued and delivered when it reconnects. Queued messages expire after ${duration(EXPIRE_AFTER_SECONDS)} offline.`;
}

/**
 * The box for a direct message to an agent, which appears only with write access; a person with read access sees why
 * it is missing. While the agent is offline the box says what happens to the message.
 */
export function DirectComposer({
  agentId,
  agentName,
  status: initialStatus,
  access,
  send,
  onSent
}: {
  agentId: string;
  agentName?: string;
  status: AgentStatus;
  access: Exclude<AgentAccess, "none">;
  send: SendAction;
  onSent: (message: ThreadMessage) => void;
}) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const endSession = useEndSession();
  const [signedOut, setSignedOut] = useState(false);
  const status = useLiveStatus(agentId, initialStatus);
  const noteId = useId();

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
        onSent(result.message);
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

  if (!mayMessage(access)) {
    return (
      <p className="rounded-lg border border-hub-line px-3 py-3 text-[13px] text-hub-muted" data-testid="read-only-thread">
        You have read access to this agent. Its owner can grant you write access to message it.
      </p>
    );
  }

  return (
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
  );
}
