"use client";

import { useCallback, useRef, useState } from "react";
import { panelPlacement, UNREACHABLE } from "@/components/assistant/ChatMenu";
import { useDismiss } from "@/components/assistant/useDismiss";
import { reviewPath } from "@/components/feedback/dev/look";
import { ARCHIVED_PROJECT_DAYS } from "@/feedback/limits";

const NOT_COPIED = "the link could not be copied; open the project to copy it from there";

/**
 * A feedback project's options in the sidebar, in the shape of `ChatMenu`: pin it for the viewer alone, copy a share
 * link, or archive it. Archive is offered only to its owner (`archivable`), and Copy only while it has a live link.
 */
export function FeedbackMenu({
  title,
  pinned,
  links,
  archivable,
  onPin,
  onArchive,
  onOpen,
  triggerClassName
}: {
  title: string;
  pinned: boolean;
  links: { label: string; token: string }[];
  archivable: boolean;
  onPin: (pinned: boolean) => Promise<void>;
  onArchive: () => Promise<void>;
  onOpen?: () => void;
  triggerClassName: string;
}) {
  const [open, setOpen] = useState<"closed" | "menu" | "links" | "archive" | "copied">("closed");
  const [problem, setProblem] = useState<string | null>(null);
  const [placed, setPlaced] = useState({ above: false, width: 240 });
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = `Options for ${title}`;

  const close = useCallback(() => {
    if (ref.current?.contains(document.activeElement)) {
      trigger.current?.focus();
    }
    setOpen("closed");
  }, []);

  useDismiss(open !== "closed", ref, close);

  function show(next: "menu" | "links" | "archive" | "copied"): void {
    setProblem(null);
    setOpen(next);
  }

  function toggle(): void {
    if (open !== "closed") {
      close();
      return;
    }
    setPlaced(panelPlacement(trigger.current));
    onOpen?.();
    show("menu");
  }

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

  async function copy(token: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${reviewPath(token)}`);
      show("copied");
    } catch {
      setProblem(NOT_COPIED);
    }
  }

  const item = "rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active";
  const [only] = links;
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
          style={{ width: placed.width }}
          className={`absolute right-0 z-30 flex flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl ${
            placed.above ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"
          }`}
        >
          {open === "menu" ? (
            <div role="menu" aria-label={label} className="flex flex-col gap-0.5">
              <button type="button" role="menuitem" className={item} onClick={() => void run(pinned ? "unpin" : "pin", () => onPin(!pinned))}>
                {pinned ? "Unpin" : "Pin"}
              </button>
              {only === undefined ? null : (
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup={links.length > 1 ? "menu" : undefined}
                  className={item}
                  onClick={() => (links.length > 1 ? show("links") : void copy(only.token))}
                >
                  Copy share link
                </button>
              )}
              {archivable ? (
                <button type="button" role="menuitem" className={`${item} text-asst-error`} onClick={() => show("archive")}>
                  Archive project
                </button>
              ) : null}
            </div>
          ) : open === "links" ? (
            <div role="menu" aria-label="Copy share link" className="flex flex-col gap-0.5">
              {links.map((link) => (
                <button key={link.token} type="button" role="menuitem" className={`${item} truncate`} onClick={() => void copy(link.token)}>
                  {link.label}
                </button>
              ))}
            </div>
          ) : open === "copied" ? (
            <p role="status" className="p-1 text-sm">
              Share link copied.
            </p>
          ) : (
            <div className="flex flex-col gap-2 p-1">
              <p className="text-sm">{`Archive this project? Its share links stop working at once, and it is deleted after ${ARCHIVED_PROJECT_DAYS} days.`}</p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={close} className="rounded-lg border border-asst-strong px-3 py-1.5 text-sm">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void run("archive", onArchive)}
                  className="rounded-lg bg-asst-error px-3 py-1.5 text-sm font-semibold text-asst-ink"
                >
                  Archive
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
