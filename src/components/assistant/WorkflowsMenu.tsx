"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { briefingRequest } from "@/assistant/briefing";
import { useDismiss } from "@/components/assistant/useDismiss";
import type { ActionResult } from "@/web/action";

/** `startConversation`: a new chat and its first message, which is how the morning briefing is run. */
export type StartChatAction = (input: { product: unknown; body: unknown; title?: unknown }) => Promise<ActionResult<{ id: string }>>;

/** One workflow the menu offers: its own page, so a link. */
type Workflow = { href: string; label: string; hint: string };

const WELSH: Workflow = { href: "/assistant/welsh", label: "Welsh translations", hint: "Search, scan, send and apply a service's Welsh" };
const SCHEDULED: Workflow = { href: "/assistant/scheduled", label: "Scheduled", hint: "Prompts your assistant runs on a schedule" };

/**
 * The sidebar's plus: the workflows a person can open beside their chats. Morning briefing is offered only to someone
 * who has connected Microsoft 365, which most of it reads, and is not a page: it starts a chat whose first message
 * runs the briefing, the same way the new-chat screen starts one, and opens it. Welsh translations is offered only to
 * someone whose assistant has the plugin that runs it; Scheduled is offered to everyone.
 *
 * Dismissed by Escape or a click outside, in the same shape as the chat menu: closing from the keyboard puts focus
 * back on the trigger, while a click elsewhere leaves focus where the click put it.
 */
export function WorkflowsMenu({ welsh = false, microsoft = false, start }: Readonly<{ welsh?: boolean; microsoft?: boolean; start?: StartChatAction }>) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const workflows = welsh ? [WELSH, SCHEDULED] : [SCHEDULED];

  const close = useCallback(() => {
    if (ref.current?.contains(document.activeElement)) {
      trigger.current?.focus();
    }
    setOpen(false);
    setError(null);
  }, []);

  async function briefing(begin: StartChatAction): Promise<void> {
    setStarting(true);
    setError(null);
    let result: ActionResult<{ id: string }>;
    try {
      result = await begin(briefingRequest(new Date()));
    } finally {
      setStarting(false);
    }
    if (!result.ok) {
      // Left open with the reason, so the person can see why nothing opened and try again.
      setError(result.error);
      return;
    }
    close();
    router.push(`/assistant/${result.id}`);
  }

  useDismiss(open, ref, close);

  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label="Workflows"
        title="Workflows"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex w-[44px] items-center justify-center self-stretch rounded-[10px] border border-asst-strong text-lg leading-none text-asst-muted hover:bg-asst-hover hover:text-asst-text"
      >
        <span aria-hidden="true">+</span>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Workflows"
          className="absolute right-0 top-[calc(100%+6px)] z-30 flex w-[240px] flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl"
        >
          {microsoft && start !== undefined ? (
            <button
              type="button"
              role="menuitem"
              disabled={starting}
              onClick={() => void briefing(start)}
              className="flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-asst-active disabled:opacity-60"
            >
              <span className="text-sm">{starting ? "Starting your briefing…" : "Morning briefing"}</span>
              <span className="text-xs text-asst-faint">Today's meetings, and the mail, chats, Jira and GitHub waiting on you</span>
            </button>
          ) : null}
          {workflows.map((workflow) => (
            <Link
              key={workflow.href}
              href={workflow.href}
              role="menuitem"
              onClick={close}
              className="flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-asst-active"
            >
              <span className="text-sm">{workflow.label}</span>
              <span className="text-xs text-asst-faint">{workflow.hint}</span>
            </Link>
          ))}
          {error === null ? null : (
            <p role="alert" className="px-2.5 py-1.5 text-xs text-asst-error">
              {error}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
