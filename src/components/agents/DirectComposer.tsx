"use client";

import { useId, useRef, useState } from "react";
import type { AgentAccess } from "@/access/rules";
import { EXPIRE_AFTER_SECONDS } from "@/agents/liveness";
import type { Skill } from "@/agents/skills";
import { useLiveStatus } from "@/components/agents/LiveStatus";
import { useDirectDraft } from "@/components/agents/useDirectDraft";
import { SEND_BUTTON, submitOnEnter } from "@/components/feed/Composer";
import { useEndSession } from "@/components/live/HubStream";
import { SessionEndedMessage } from "@/components/live/SessionEnded";
import { sessionEnded } from "@/components/live/session";
import { type SkillMenuTheme, useSkillMenu } from "@/components/SkillMenu";
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

/** The list sits in the flow above the box, which is what pushes the box down to make room for it. */
const SKILL_MENU: SkillMenuTheme = {
  list: "mx-2 mt-2 max-h-60 overflow-y-auto rounded-sm border border-hub-line bg-hub-raised py-1 text-[13px]",
  option: "cursor-pointer px-3 py-1",
  active: "bg-hub-active text-white",
  idle: "text-hub-text hover:bg-hub-hover",
  name: "font-mono font-bold",
  description: (active) => `block truncate ${active ? "text-white" : "text-hub-muted"}`
};

/**
 * The box for a direct message to an agent, which appears only with write access; a person with read access sees why
 * it is missing. While the agent is offline the box says what happens to the message. An unsent message is kept as a
 * per-agent draft, so going to another agent and back finds it where it was.
 */
export function DirectComposer({
  agentId,
  agentName,
  virtualAgentId = null,
  viewerOid,
  status: initialStatus,
  access,
  skills = [],
  send,
  onSent
}: {
  agentId: string;
  agentName?: string;
  /** The virtual agent whose session this agent is, or `null` for a session on a laptop. */
  virtualAgentId?: string | null;
  /** Who is reading, so the box never shows the draft of whoever signed in on this tab before them. */
  viewerOid: string;
  status: AgentStatus;
  access: Exclude<AgentAccess, "none">;
  /** The agent's skills, offered when the message starts with "/". */
  skills?: readonly Skill[];
  send: SendAction;
  onSent: (message: ThreadMessage) => void;
}) {
  // The message is sent to the session agent, but kept under the virtual agent: a `/clear` replaces the session while
  // the person is still typing on the same page, and the draft has to outlive that.
  const { body, setBody, discard } = useDirectDraft({ viewerOid, draftId: virtualAgentId ?? agentId });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const endSession = useEndSession();
  const [signedOut, setSignedOut] = useState(false);
  const status = useLiveStatus(agentId, initialStatus);
  const noteId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const menu = useSkillMenu({ skills, body, setBody, field, theme: SKILL_MENU });

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
        // This submit's `discard`, so it forgets the draft under the key the message was sent from even where the
        // page has since remounted or re-keyed the box: a `/clear` arriving mid-send does both.
        discard(body);
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
    <form
      method="post"
      onSubmit={submit}
      className="rounded-lg border border-hub-line bg-hub-pane focus-within:border-hub-muted"
      aria-label="Message this agent"
    >
      {status === "offline" ? (
        <p id={noteId} className="rounded-t-lg bg-hub-raised px-3 py-1.5 text-xs text-amber-300">
          {offlineNote(agentName)}
        </p>
      ) : null}
      {menu.list}
      <label className="block">
        <span className="sr-only">Message this agent</span>
        <textarea
          ref={field}
          {...menu.fieldProps}
          value={body}
          onChange={(event) => {
            menu.onChange(event.target.value);
            menu.track(event);
          }}
          onSelect={menu.track}
          onKeyDown={(event) => {
            if (!menu.onKeyDown(event)) {
              submitOnEnter(event);
            }
          }}
          aria-describedby={status === "offline" ? noteId : undefined}
          required
          rows={2}
          maxLength={32_000}
          placeholder={agentName ? `Message @${agentName}` : "Message this agent"}
          className="block max-h-60 w-full resize-y bg-transparent px-3 pt-2.5 pb-1 text-[15px] text-hub-text placeholder:text-hub-muted focus:outline-hidden"
        />
      </label>
      <div className="flex items-center gap-3 px-2 pb-2">
        <span className="text-xs text-hub-muted">Enter to send, Shift+Enter for a new line{skills.length > 0 ? ", / for a skill" : ""}</span>
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
