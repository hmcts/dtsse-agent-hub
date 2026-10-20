"use client";

import { useEffect, useRef, useState } from "react";

/**
 * How long a keystroke may sit unwritten. A trailing throttle, not a debounce: continuous typing still reaches storage
 * every `SAVE_AFTER_MS`, so a crash loses at most that much, and the hook also flushes when the box goes away.
 */
const SAVE_AFTER_MS = 300;

/** Namespaced and keyed by agent, so no two agents share a draft and nothing else the app stores can collide with one. */
export function draftKey(agentId: string): string {
  return `agent-hub:direct-draft:${agentId}`;
}

/**
 * `sessionStorage`, not `localStorage`: a half-written message is worth keeping across an accidental reload or a trip
 * to another agent, but one that reappears days later in a new browser session is a surprise rather than a kindness.
 *
 * Every access is wrapped, because storage throws in Safari private browsing and when the quota is full, and is absent
 * server-side and in tests. Losing a draft is never worth breaking the composer.
 */
function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readDraft(agentId: string): string {
  try {
    return store()?.getItem(draftKey(agentId)) ?? "";
  } catch {
    return "";
  }
}

/** A box the person emptied by hand has no draft to keep, so the key goes rather than holding blank text. */
function saveDraft(agentId: string, body: string): void {
  try {
    if (body.trim() === "") {
      store()?.removeItem(draftKey(agentId));
    } else {
      store()?.setItem(draftKey(agentId), body);
    }
  } catch {
    // Nothing to do: the draft is still in the box, it just will not outlive it.
  }
}

/**
 * The text of a direct message, kept per agent so leaving an agent's page and coming back finds it where it was.
 *
 * The state starts empty and the stored draft arrives in an effect, so the first client render matches what the server
 * rendered; reading storage while rendering would be a hydration mismatch. `discard` is for a message that was sent —
 * a failed send keeps its draft, which is when it is worth the most.
 */
export function useDirectDraft(agentId: string) {
  const [body, setBody] = useState("");
  /** The keystrokes not yet written, with the agent they belong to: `agentId` may change before the timer fires. */
  const owed = useRef<{ agentId: string; body: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setBody(readDraft(agentId));
    return () => {
      // Write what is owed before this agent's box goes away, so clicking to another agent cannot lose the last keystrokes.
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (owed.current !== null) {
        saveDraft(owed.current.agentId, owed.current.body);
        owed.current = null;
      }
    };
  }, [agentId]);

  function edit(next: string): void {
    setBody(next);
    owed.current = { agentId, body: next };
    if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        const pending = owed.current;
        owed.current = null;
        if (pending !== null) {
          saveDraft(pending.agentId, pending.body);
        }
      }, SAVE_AFTER_MS);
    }
  }

  function discard(): void {
    setBody("");
    owed.current = null;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    saveDraft(agentId, "");
  }

  return { body, setBody: edit, discard };
}
