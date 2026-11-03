"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { useDismiss } from "@/components/assistant/useDismiss";

/** One workflow the menu offers: its own page, so a link. */
type Workflow = { href: string; label: string; hint: string };

const WELSH: Workflow = { href: "/assistant/welsh", label: "Welsh translations", hint: "Search, scan, send and apply a service's Welsh" };
const SCHEDULED: Workflow = { href: "/assistant/scheduled", label: "Scheduled", hint: "Prompts your assistant runs on a schedule" };

/**
 * The sidebar's plus: the workflows a person can open beside their chats, each its own page. Welsh translations is
 * offered only to someone whose assistant has the plugin that runs it; Scheduled is offered to everyone.
 *
 * Dismissed by Escape or a click outside, in the same shape as the chat menu: closing from the keyboard puts focus
 * back on the trigger, while a click elsewhere leaves focus where the click put it.
 */
export function WorkflowsMenu({ welsh = false }: Readonly<{ welsh?: boolean }>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const workflows = welsh ? [WELSH, SCHEDULED] : [SCHEDULED];

  const close = useCallback(() => {
    if (ref.current?.contains(document.activeElement)) {
      trigger.current?.focus();
    }
    setOpen(false);
  }, []);

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
        </div>
      ) : null}
    </div>
  );
}
