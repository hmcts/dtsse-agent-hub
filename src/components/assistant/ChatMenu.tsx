"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDismiss } from "@/components/assistant/useDismiss";

const TRIGGER = "flex h-[34px] w-[34px] items-center justify-center rounded-[9px] text-lg text-asst-muted hover:bg-asst-field hover:text-asst-text";

/**
 * A generous allowance for the panel's height, used to decide which way it opens before it is rendered and can be
 * measured. Its tallest pane, a laptop chat's delete confirmation carrying a refusal, comes to about 210px.
 */
const PANEL_HEIGHT = 250;

/** How wide the panel is wherever there is room for it; the sidebar can be dragged narrower than this. */
const PANEL_WIDTH = 240;

/** Kept between the panel's left edge and whatever would clip it, so it never sits flush against the sidebar. */
const PANEL_INSET = 4;

/** What an action that rejects gets instead of its own refusal, having never reached the server to be refused. */
export const UNREACHABLE = (what: string) => `the ${what} could not be sent; check your connection and try again`;

/**
 * The room around `element` before the nearest edge that would clip the panel: whichever is closer, the window or a
 * scrolling ancestor. Both matter in the sidebar, whose list of chats scrolls, ends well above the bottom of the
 * window, and can be dragged narrower than the panel's own width.
 *
 * `beside` is measured to the left, because the panel hangs from the element's right edge.
 */
function room(element: HTMLElement): { above: number; below: number; beside: number } {
  const rect = element.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  let left = 0;
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") {
      const box = node.getBoundingClientRect();
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
      left = Math.max(left, box.left);
    }
  }
  return { above: rect.top - top, below: bottom - rect.bottom, beside: rect.right - left - PANEL_INSET };
}

/** Which way a sidebar row's panel opens and how wide it is, from the room around its trigger. */
export function panelPlacement(trigger: HTMLElement | null): { above: boolean; width: number } {
  const space = trigger === null ? null : room(trigger);
  // An environment without layout, such as jsdom, measures zeros, so the panel opens downward at its full width,
  // as it does wherever there is room for it.
  return {
    above: space !== null && space.below < PANEL_HEIGHT && space.above >= PANEL_HEIGHT,
    width: space === null || space.beside <= 0 ? PANEL_WIDTH : Math.min(PANEL_WIDTH, space.beside)
  };
}

const LOCAL_DELETE_NOTE = "The session on your computer will not come back to your chats, even if you resume it. A new session starts a new chat.";

/**
 * A conversation's options: share it read-only, offer it to be forked, pin it above the date groups or unpin it,
 * rename it, or delete it and its document. Shown from the chat's header for the open conversation and from every row
 * of the sidebar, so the destructive confirmation is written once.
 *
 * Share and Fork are links rather than panes of their own: the dialog lives at the chat's own address, so it can be reached
 * from anywhere and the browser's back button closes it.
 *
 * Dismissed by Escape or a click outside, in the same shape as the hub's other menus: closing from the keyboard puts
 * focus back on the trigger, while a click elsewhere leaves focus where the click put it. The panel opens upward when
 * there is no room for it below.
 */
export function ChatMenu({
  title,
  shareHref,
  forkHref,
  pinned,
  onPin,
  onRename,
  onDelete,
  onOpen,
  local = false,
  label = "Chat options",
  triggerClassName = TRIGGER
}: {
  title: string;
  /** Where the share dialog for this chat is. */
  shareHref: string;
  /** Where the dialog offering this chat to be forked is. */
  forkHref: string;
  /** Whether the chat is pinned, which makes the item Unpin. */
  pinned: boolean;
  /** Called with the state the person asked for: true to pin, false to unpin. */
  onPin: (pinned: boolean) => Promise<void>;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
  /** Called as the menu opens, so whatever is shown about the last attempt can be dropped. */
  onOpen?: () => void;
  /**
   * A chat with a session on the person's own computer. Deleting one is permanent for that session, which the hub
   * never gives a chat again, so the confirmation says so.
   */
  local?: boolean;
  /** The accessible name of the trigger and of the menu. Name the chat wherever more than one menu is on the page. */
  label?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState<"closed" | "menu" | "rename" | "delete">("closed");
  const [draft, setDraft] = useState(title);
  const [problem, setProblem] = useState<string | null>(null);
  const [above, setAbove] = useState(false);
  const [width, setWidth] = useState(PANEL_WIDTH);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleBox = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    if (ref.current?.contains(document.activeElement)) {
      trigger.current?.focus();
    }
    setOpen("closed");
  }, []);

  useEffect(() => {
    if (open === "rename") {
      titleBox.current?.focus();
    }
  }, [open]);

  useDismiss(open !== "closed", ref, close);

  /** Opens a pane, forgetting whatever the last attempt reported. */
  function show(next: "menu" | "rename" | "delete"): void {
    setProblem(null);
    setOpen(next);
  }

  function toggle(): void {
    if (open !== "closed") {
      close();
      return;
    }
    const placed = panelPlacement(trigger.current);
    setAbove(placed.above);
    setWidth(placed.width);
    onOpen?.();
    show("menu");
  }

  /**
   * Runs one of the actions. An action answers its own refusal, which belongs beside the chat rather than in a
   * panel over it, so the panel closes on any answer at all and stays open only when none arrived.
   */
  async function run(what: string, work: () => Promise<void>): Promise<void> {
    setProblem(null);
    try {
      await work();
    } catch {
      setProblem(UNREACHABLE(what));
      return;
    }
    close();
  }

  const item = "rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active";
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open !== "closed"}
        onClick={toggle}
        className={triggerClassName}
      >
        ⋯
      </button>
      {open === "closed" ? null : (
        <div
          style={{ width }}
          className={`absolute right-0 z-30 flex flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl ${
            above ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"
          }`}
        >
          {open === "menu" ? (
            <div role="menu" aria-label={label} className="flex flex-col gap-0.5">
              <Link href={shareHref} role="menuitem" className={item} onClick={close}>
                Share
              </Link>
              <Link href={forkHref} role="menuitem" className={item} onClick={close}>
                Fork
              </Link>
              <button type="button" role="menuitem" className={item} onClick={() => void run(pinned ? "unpin" : "pin", () => onPin(!pinned))}>
                {pinned ? "Unpin" : "Pin"}
              </button>
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  setDraft(title);
                  show("rename");
                }}
              >
                Rename
              </button>
              <button type="button" role="menuitem" className={`${item} text-asst-error`} onClick={() => show("delete")}>
                Delete chat
              </button>
            </div>
          ) : open === "rename" ? (
            <form
              method="post"
              className="flex flex-col gap-2 p-1"
              onSubmit={(event) => {
                event.preventDefault();
                void run("new name", () => onRename(draft));
              }}
            >
              {/* The box is inside its label, so nothing has to be unique to the one menu that is open. */}
              <label className="flex flex-col gap-2">
                <span className="text-xs text-asst-faint">Chat name</span>
                <input
                  ref={titleBox}
                  value={draft}
                  maxLength={200}
                  onChange={(event) => setDraft(event.target.value)}
                  className="rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-sm outline-hidden focus:border-asst-accent-line"
                />
              </label>
              <button type="submit" className="self-end rounded-lg bg-asst-accent px-3 py-1.5 text-sm font-semibold text-asst-ink">
                Save
              </button>
            </form>
          ) : (
            <div className="flex flex-col gap-2 p-1">
              <p className="text-sm">Delete this chat and its document? This cannot be undone.</p>
              {local ? <p className="text-sm">{LOCAL_DELETE_NOTE}</p> : null}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={close} className="rounded-lg border border-asst-strong px-3 py-1.5 text-sm">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void run("delete", onDelete)}
                  className="rounded-lg bg-asst-error px-3 py-1.5 text-sm font-semibold text-asst-ink"
                >
                  Delete
                </button>
              </div>
            </div>
          )}
          {problem === null ? null : (
            <p role="alert" className="px-1.5 pb-1 text-xs text-asst-error">
              {problem}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
