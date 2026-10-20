"use client";

import { useEffect, useState } from "react";

/**
 * How long a keystroke may sit unwritten. A trailing throttle, not a debounce: continuous typing still reaches storage
 * every `SAVE_AFTER_MS`, so a crash loses at most that much, and the hook also flushes when the box goes away and when
 * the page is hidden.
 */
const SAVE_AFTER_MS = 300;

/** What every draft key starts with, so a mount can tell one from everything else the app keeps in the tab. */
const KEY_PREFIX = "agent-hub:direct-draft:";

/**
 * Namespaced, scoped to the viewer, and keyed by the agent the draft belongs to, so no two agents share a draft and
 * nothing else the app stores can collide with one.
 *
 * Scoped to the viewer because `sessionStorage` is per tab, not per sign-in: on a shared workstation one person can
 * sign out and another sign in in the same tab, and the tab's storage outlives both. The scoping is what keeps the
 * first person's unsent message out of the second person's box; `forgetOtherViewers` is what gets it out of the tab.
 */
export function draftKey(viewerOid: string, draftId: string): string {
  return `${KEY_PREFIX}${viewerOid}:${draftId}`;
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
 * Drops every draft belonging to someone other than the person reading, so one person signing out and another signing
 * in on the same tab does not leave the first person's unsent messages in the tab.
 *
 * It narrows the window rather than closing it: signing out is a plain document navigation that no component sees, so
 * between the sign-out and the next person opening an agent page the text is still in `sessionStorage` for anyone at
 * that workstation to read in devtools. Viewer scoping is what keeps it out of their box; this is what stops it
 * sitting there for the rest of the tab's life.
 */
function forgetOtherViewers(viewerOid: string): void {
  try {
    const storage = store();
    if (storage === null) {
      return;
    }
    const mine = `${KEY_PREFIX}${viewerOid}:`;
    const theirs: string[] = [];
    // Collected first: removing while walking the indexes would shift the keys not yet looked at.
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(KEY_PREFIX) === true && !key.startsWith(mine)) {
        theirs.push(key);
      }
    }
    for (const key of theirs) {
      storage.removeItem(key);
    }
  } catch {
    // Nothing to do: storage that will not answer is storage nobody can read the drafts out of either.
  }
}

/**
 * A draft a box is open on: the text it shows, the keystrokes not yet written, and the boxes to empty when a send
 * against it succeeds. A keystroke updates only the box it was typed in, which is the only one that can have one.
 */
type Draft = {
  text: string;
  owed: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  boxes: Set<(text: string) => void>;
};

/**
 * Every draft with a box open on it in this tab, by key.
 *
 * A send is accounted for against the key the message was typed under rather than against the box it was typed in,
 * because that box may be gone or re-keyed by the time it resolves: a `/clear` registers a new session agent, which
 * remounts the conversation, so a message can be sent from one box and succeed while a second box is showing the
 * draft the first one flushed on its way out. Holding the text here, where every box on the key can reach it, is what
 * lets the box that is mounted now empty itself when the send that filled it succeeds.
 */
const drafts = new Map<string, Draft>();

function openDraft(key: string): Draft {
  const open = drafts.get(key);
  if (open !== undefined) {
    return open;
  }
  const opened: Draft = { text: readDraft(key), owed: null, timer: null, boxes: new Set() };
  drafts.set(key, opened);
  return opened;
}

/** Writes whatever the throttle still owes, so the keystrokes in its window outlive the box and the page. */
function flush(key: string): void {
  const draft = drafts.get(key);
  if (draft === undefined) {
    return;
  }
  if (draft.timer !== null) {
    clearTimeout(draft.timer);
    draft.timer = null;
  }
  if (draft.owed !== null) {
    saveDraft(key, draft.owed);
    draft.owed = null;
  }
}

function write(key: string, body: string): void {
  const draft = openDraft(key);
  draft.text = body;
  draft.owed = body;
  if (draft.timer === null) {
    draft.timer = setTimeout(() => {
      draft.timer = null;
      if (draft.owed !== null) {
        saveDraft(key, draft.owed);
        draft.owed = null;
      }
    }, SAVE_AFTER_MS);
  }
}

/**
 * Forgets the draft of the message that was `sent`, and only that message: the box is not disabled while a send is in
 * flight, so by the time it resolves the person may have started the next message, and that text is the draft now.
 *
 * The text to compare against is the one the key holds — the open box's, which is up to `SAVE_AFTER_MS` ahead of
 * storage, or what was flushed to storage when no box is open on it any more.
 */
function forgetSent(key: string, sent: string): void {
  const draft = drafts.get(key);
  if ((draft?.text ?? readDraft(key)) !== sent) {
    return;
  }
  if (draft !== undefined) {
    draft.text = "";
    draft.owed = null;
    if (draft.timer !== null) {
      clearTimeout(draft.timer);
      draft.timer = null;
    }
  }
  saveDraft(key, "");
  for (const box of draft?.boxes ?? []) {
    box("");
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
 * a failed send keeps its draft, which is when it is worth the most — and carries the key it was sent under, so it
 * reaches the draft the message came from whichever box is showing it now.
 */
export function useDirectDraft({ viewerOid, draftId }: { viewerOid: string; draftId: string }) {
  const key = draftKey(viewerOid, draftId);
  const [body, setBody] = useState("");

  useEffect(() => {
    forgetOtherViewers(viewerOid);
    const draft = openDraft(key);
    draft.boxes.add(setBody);
    setBody(draft.text);

    // A reload or a same-tab navigation unloads a page that never became hidden, and a backgrounded tab is frozen or
    // discarded without ever being unloaded, so it takes both events to cover a draft the throttle still owes.
    // `beforeunload` covers neither reliably and costs the page its place in the back/forward cache.
    const onPageHide = () => flush(key);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flush(key);
      }
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // Write what is owed before this box goes away, so clicking to another agent cannot lose the last keystrokes.
      flush(key);
      draft.boxes.delete(setBody);
      if (draft.boxes.size === 0) {
        // Nothing is showing this draft any more, and storage now holds it: a later box reads it back from there.
        drafts.delete(key);
      }
    };
  }, [key, viewerOid]);

  function edit(next: string): void {
    setBody(next);
    write(key, next);
  }

  function discard(sent: string): void {
    forgetSent(key, sent);
  }

  return { body, setBody: edit, discard };
}
