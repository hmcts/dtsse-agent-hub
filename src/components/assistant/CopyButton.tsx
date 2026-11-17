"use client";

import { useEffect, useRef, useState } from "react";
import { CopyIcon, TickIcon } from "@/components/sidebar/icons";

/** How long the tick and its announcement stay after a copy. A failure stays until the next attempt. */
const COPIED_FOR_MS = 1400;

/**
 * Copies `text` to the clipboard, as the document panel's toolbar does: a tick in place of the icon says it worked, by
 * shape rather than by colour, and a status says it aloud. A failure has to be read, so it is on screen.
 */
export function CopyButton({ text, label, className = "" }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  async function copy(): Promise<void> {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setState("failed");
      return;
    }
    setState("copied");
    timer.current = setTimeout(() => setState("idle"), COPIED_FOR_MS);
  }

  return (
    <span className={`flex items-center gap-1.5 print:hidden ${className}`}>
      <span role="status" className={state === "failed" ? "text-xs text-asst-error" : "sr-only"}>
        {state === "copied" ? "Copied" : state === "failed" ? "Could not copy. Select the text and copy it yourself." : ""}
      </span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-asst-muted hover:bg-asst-field hover:text-asst-text"
      >
        {state === "copied" ? <TickIcon /> : <CopyIcon />}
      </button>
    </span>
  );
}
