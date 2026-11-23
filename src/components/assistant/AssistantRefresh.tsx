"use client";

import { usePathname, useRouter } from "next/navigation";
import { useHubEvent } from "@/components/live/HubStream";
import { useSettled } from "@/components/live/useSettled";

/** A Bulk Scan form's editor, whose page keeps edits that are not saved. */
const BULK_SCAN_EDITOR = /^\/assistant\/bulk-scan\/[^/]+/;

/**
 * Re-renders the Assistant's server components when the viewer's assistant, one of their conversations, one of their
 * feedback projects, one of their Bulk Scan forms, or the skills the page's composer offers change: the events carry only ids, so the page reads what changed itself.
 * Every one of them is refreshed here rather than where it is shown, so a cold chat coming up — which reports its
 * status, its skills and its conversation from the one transaction — re-reads the page once.
 *
 * Nothing is refreshed while a Bulk Scan form's editor is the page: a refresh there starts the editor afresh from the
 * newest version and drops edits not yet saved. A save made elsewhere shows as the conflict the editor's own save
 * reports, and the sidebar catches up on the next page.
 *
 * The settled refresh waits for the network, because refreshing without one takes the page to the error boundary;
 * see `live/connectivity.ts` and `live/useSettled.ts`.
 */
export function AssistantRefresh() {
  const router = useRouter();
  const editing = BULK_SCAN_EDITOR.test(usePathname());
  const { settle } = useSettled(() => router.refresh());
  const refresh = () => {
    if (!editing) {
      settle();
    }
  };
  useHubEvent("assistant_conversation", refresh);
  useHubEvent("virtual_agent", refresh);
  // Unfiltered: the stream scopes it, to the open conversation's agent on its page, and to any of the viewer's own
  // agents on a page watching none, which is how the new-chat screen's pod list stays current.
  useHubEvent("agent_skills", refresh);
  // Sent only for a project the viewer is on the team of, so every one is a change to a row of the sidebar or a project
  // just shared with them: its count, its place in the date groups, or its archiving.
  useHubEvent("feedback", refresh);
  // Each of the viewer's Bulk Scan forms is a row of the sidebar, so one added, saved, signed off or deleted changes it.
  useHubEvent("bulk_scan_spec", refresh);
  return null;
}
