"use client";

import { useEffect, useRef, useState } from "react";

/**
 * How long a keystroke may sit unwritten. A trailing throttle, not a debounce: continuous typing still reaches storage
 * every `SAVE_AFTER_MS`, so a crash loses at most that much, and the hook also flushes when the box goes away.
 */
const SAVE_AFTER_MS = 300;

/**
 * Namespaced, scoped to the viewer, and keyed by the agent the draft belongs to, so no two agents share a draft and
 * nothing else the app stores can collide with one.
 *
 * Scoped to the viewer because `sessionStorage` is per tab, not per sign-in: on a shared workstation one person can
 * sign out and another sign in in the same tab, which keeps the tab's storage, and nobody should find someone else's
 * unsent message in their box. Clearing the drafts when the session ends would not cover that, since signing out is a
 * plain navigation no component sees.
 */
export function draftKey(viewerOid: string, draftId: string): string {
  return `agent-hub:direct-draft:${viewerOid}:${draftId}`;
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

function readDraft(key: string): string {
  try {
    return store()?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** A box the person emptied by hand has no draft to keep, so the key goes rather than holding blank text. */
function saveDraft(key: string, body: string): void {
  try {
    if (body.trim() === "") {
      store()?.removeItem(key);
    } else {
      store()?.setItem(key, body);
    }
  } catch {
    // Nothing to do: the draft is still in the box, it just will not outlive it.
  }
}

/**
 * The text of a direct message, kept per agent so leaving an agent's page and coming back finds it where it was.
 *
 * `draftId` is what the draft is keyed on, which is not always the agent the message is sent to: a virtual agent
 * registers a new agent on every `/clear`, and its page remounts the composer with the new session's id while the
 * person is still typing on the page they never left, so a virtual agent's draft is keyed on the virtual agent.
 *
 * The state starts empty and the stored draft arrives in an effect, so the first client render matches what the server
 * rendered; reading storage while rendering would be a hydration mismatch. `discard` is for a message that was sent —
 * a failed send keeps its draft, which is when it is worth the most.
 */
export function useDirectDraft({ viewerOid, draftId }: { viewerOid: string; draftId: string }) {
  const key = draftKey(viewerOid, draftId);
  const [body, setBody] = useState("");
  /** What is in the box now, which a send that started some keystrokes ago cannot read from its own closure. */
  const latest = useRef("");
  /** The keystrokes not yet written, with the key they belong to: `key` may change before the timer fires. */
  const owed = useRef<{ key: string; body: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const stored = readDraft(key);
    latest.current = stored;
    setBody(stored);
    return () => {
      // Write what is owed before this box goes away, so clicking to another agent cannot lose the last keystrokes.
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (owed.current !== null) {
        saveDraft(owed.current.key, owed.current.body);
        owed.current = null;
      }
    };
  }, [key]);

  function edit(next: string): void {
    setBody(next);
    latest.current = next;
    owed.current = { key, body: next };
    if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        const pending = owed.current;
        owed.current = null;
        if (pending !== null) {
          saveDraft(pending.key, pending.body);
        }
      }, SAVE_AFTER_MS);
    }
  }

  /**
   * Forgets the draft of the message that was `sent`, and only that message: the box is not disabled while a send is
   * in flight, so by the time it resolves the person may have started the next message, and that text is the draft
   * now.
   */
  function discard(sent: string): void {
    if (latest.current !== sent) {
      return;
    }
    setBody("");
    latest.current = "";
    owed.current = null;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    saveDraft(key, "");
  }

  return { body, setBody: edit, discard };
}
