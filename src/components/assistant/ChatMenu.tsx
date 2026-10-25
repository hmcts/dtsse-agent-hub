"use client";

import { useEffect, useRef, useState } from "react";

const TRIGGER = "flex h-[34px] w-[34px] items-center justify-center rounded-[9px] text-lg text-asst-muted hover:bg-asst-field hover:text-asst-text";

/** Roughly the tallest the panel gets, which is its delete confirmation, used to decide which way it opens. */
const PANEL_HEIGHT = 170;

/**
 * A conversation's options: rename it, or delete it and its document. Shown from the chat's header for the open
 * conversation and from every row of the sidebar, so the destructive confirmation is written once.
 *
 * The panel opens upward when there is no room for it below, because the sidebar's list scrolls and clips it.
 */
export function ChatMenu({
  title,
  onRename,
  onDelete,
  label = "Chat options",
  triggerClassName = TRIGGER
}: {
  title: string;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
  /** The accessible name of the trigger and of the menu. Name the chat wherever more than one menu is on the page. */
  label?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState<"closed" | "menu" | "rename" | "delete">("closed");
  const [draft, setDraft] = useState(title);
  const [above, setAbove] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open === "rename") {
      titleBox.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (open === "closed") {
      return;
    }
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) {
        setOpen("closed");
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  function toggle() {
    if (open !== "closed") {
      setOpen("closed");
      return;
    }
    const rect = trigger.current?.getBoundingClientRect();
    // An environment without layout, such as jsdom, measures zeros, so the panel opens downward as it does whenever
    // there is room below.
    setAbove(rect !== undefined && rect.bottom + PANEL_HEIGHT > window.innerHeight && rect.top > PANEL_HEIGHT);
    setOpen("menu");
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
          className={`absolute right-0 z-30 flex w-[240px] flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl ${
            above ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"
          }`}
        >
          {open === "menu" ? (
            <div role="menu" aria-label={label} className="flex flex-col gap-0.5">
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  setDraft(title);
                  setOpen("rename");
                }}
              >
                Rename
              </button>
              <button type="button" role="menuitem" className={`${item} text-asst-error`} onClick={() => setOpen("delete")}>
                Delete chat
              </button>
            </div>
          ) : open === "rename" ? (
            <form
              method="post"
              className="flex flex-col gap-2 p-1"
              onSubmit={(event) => {
                event.preventDefault();
                void onRename(draft).then(() => setOpen("closed"));
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
                  className="rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-sm outline-none focus:border-asst-accent-line"
                />
              </label>
              <button type="submit" className="self-end rounded-lg bg-asst-accent px-3 py-1.5 text-sm font-semibold text-asst-ink">
                Save
              </button>
            </form>
          ) : (
            <div className="flex flex-col gap-2 p-1">
              <p className="text-sm">Delete this chat and its document? This cannot be undone.</p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setOpen("closed")} className="rounded-lg border border-asst-strong px-3 py-1.5 text-sm">
                  Cancel
                </button>
                <button type="button" onClick={() => void onDelete()} className="rounded-lg bg-asst-error px-3 py-1.5 text-sm font-semibold text-asst-ink">
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
