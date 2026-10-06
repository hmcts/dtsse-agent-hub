"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import type { AgentAccess } from "@/access/rules";
import { EXPIRE_AFTER_SECONDS } from "@/agents/liveness";
import { matchSkills, pickSkill, type Skill, skillQuery } from "@/agents/skills";
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
 * The "/" autocomplete over the agent's skills, as a WAI-ARIA combobox on the textarea. It opens while the caret is in
 * a "/" token that starts the message, and Escape keeps it shut until the message changes.
 */
function useSkillMenu(skills: readonly Skill[], body: string, setBody: (body: string) => void) {
  const listId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [lastQuery, setLastQuery] = useState<string | null>(null);
  const placeCaret = useRef<number | null>(null);

  const query = skills.length === 0 ? null : skillQuery(body, caret);
  if (query !== lastQuery) {
    setLastQuery(query);
    setActive(0);
  }
  const matches = query === null ? [] : matchSkills(skills, query);
  const open = !dismissed && matches.length > 0;
  const current = open ? Math.min(active, matches.length - 1) : -1;
  const optionId = (index: number) => `${listId}-${index}`;

  useLayoutEffect(() => {
    if (placeCaret.current !== null && field.current !== null) {
      field.current.setSelectionRange(placeCaret.current, placeCaret.current);
      placeCaret.current = null;
    }
  });

  function pick(skill: Skill): void {
    const picked = pickSkill(body, skill.name);
    placeCaret.current = picked.caret;
    setCaret(picked.caret);
    setBody(picked.body);
    field.current?.focus();
  }

  /** Whether the key was the menu's, so the composer must not also act on it. */
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open) {
      return false;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
      setActive((current + step) % matches.length);
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) || event.key === "Tab") {
      event.preventDefault();
      const chosen = matches[current];
      if (chosen !== undefined) {
        pick(chosen);
      }
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    return false;
  }

  function track(event: React.SyntheticEvent<HTMLTextAreaElement>): void {
    setCaret(event.currentTarget.selectionStart);
  }

  function onChange(value: string): void {
    setDismissed(false);
    setBody(value);
  }

  const fieldProps =
    skills.length === 0
      ? {}
      : {
          role: "combobox",
          "aria-autocomplete": "list" as const,
          "aria-expanded": open,
          "aria-controls": listId,
          "aria-activedescendant": open ? optionId(current) : undefined
        };

  const list = (
    <div
      id={listId}
      role="listbox"
      aria-label="Skills"
      hidden={!open}
      className="mx-2 mt-2 max-h-60 overflow-y-auto rounded border border-hub-line bg-hub-raised py-1 text-[13px]"
    >
      {open
        ? matches.map((skill, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the textarea keeps focus and handles the keys, through aria-activedescendant
            <div
              key={skill.name}
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={index === current}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(skill)}
              className={`cursor-pointer px-3 py-1 ${index === current ? "bg-hub-active text-white" : "text-hub-text hover:bg-hub-hover"}`}
            >
              <span className="font-mono font-bold">/{skill.name}</span>
              {skill.description ? <span className={`block truncate ${index === current ? "text-white" : "text-hub-muted"}`}>{skill.description}</span> : null}
            </div>
          ))
        : null}
    </div>
  );

  return { field, fieldProps, list: skills.length === 0 ? null : list, onKeyDown, onChange, track };
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
  skills = [],
  send,
  onSent
}: {
  agentId: string;
  agentName?: string;
  status: AgentStatus;
  access: Exclude<AgentAccess, "none">;
  /** The agent's skills, offered when the message starts with "/". */
  skills?: readonly Skill[];
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
  const menu = useSkillMenu(skills, body, setBody);

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
      {menu.list}
      <label className="block">
        <span className="sr-only">Message this agent</span>
        <textarea
          ref={menu.field}
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
          className="block max-h-60 w-full resize-y bg-transparent px-3 pt-2.5 pb-1 text-[15px] text-hub-text placeholder:text-hub-muted focus:outline-none"
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
