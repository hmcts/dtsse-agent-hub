"use client";

import { type DraftKind, draftKey as keyOf, useDraft } from "@/components/useDraft";

/**
 * The kind every direct-message draft is stored under. The assistant's conversations keep drafts of their own, and
 * this is what keeps the two apart; the string is also what the hub's drafts have always been stored under, so a
 * person with a half-written message and a tab open across a deploy still finds it.
 */
const KIND: DraftKind = "direct-draft";

/** Where a direct message's draft is kept in the tab. */
export function draftKey(viewerOid: string, draftId: string): string {
  return keyOf(KIND, viewerOid, draftId);
}

/**
 * The text of a direct message, kept per agent so leaving an agent's page and coming back finds it where it was.
 *
 * `draftId` is what the draft is keyed on, which is not always the agent the message is sent to: a virtual agent
 * registers a new agent on every `/clear`, and its page remounts the composer with the new session's id while the
 * person is still typing on the page they never left, so a virtual agent's draft is keyed on the virtual agent.
 */
export function useDirectDraft({ viewerOid, draftId }: { viewerOid: string; draftId: string }) {
  return useDraft({ kind: KIND, viewerOid, draftId });
}
