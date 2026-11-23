"use client";

import { usePathname, useRouter } from "next/navigation";
import { useHubEvent } from "@/components/live/HubStream";
import { useSettled } from "@/components/live/useSettled";

/**
 * Re-renders the Assistant's server components when the viewer's assistant, one of their conversations, one of their
 * feedback projects, one of their Bulk Scan forms, or the skills the page's composer offers change: the events carry only ids, so the page reads what changed itself.
 * A Bulk Scan form's change is not read while its editor is open: a refresh there would start the editor afresh and
 * drop edits not yet saved, a save made elsewhere shows as the conflict the editor's own save reports, and the sidebar
 * catches up on the next page.
 * Every one of them is refreshed here rather than where it is shown, so a cold chat coming up — which reports its
 * status, its skills and its conversation from the one transaction — re-reads the page once.
 *
 * The settled refresh waits for the network, because refreshing without one takes the page to the error boundary;
 * see `live/connectivity.ts` and `live/useSettled.ts`.
 */
const BULK_SCAN_EDITOR = /^\/assistant\/bulk-scan\/[^/]+/;

export function AssistantRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  const { settle: refresh } = useSettled(() => router.refresh());
  useHubEvent("assistant_conversation", refresh);
  useHubEvent("virtual_agent", refresh);
  // Unfiltered: the stream scopes it, to the open conversation's agent on its page, and to any of the viewer's own
  // agents on a page watching none, which is how the new-chat screen's pod list stays current.
  useHubEvent("agent_skills", refresh);
  // Sent only for a project the viewer is on the team of, so every one is a change to a row of the sidebar or a project
  // just shared with them: its count, its place in the date groups, or its archiving.
  useHubEvent("feedback", refresh);
  // Each of the viewer's Bulk Scan forms is a row of the sidebar, so one added, saved, signed off or deleted changes it.
  useHubEvent("bulk_scan_spec", () => {
    if (!BULK_SCAN_EDITOR.test(pathname)) {
      refresh();
    }
  });
  return null;
}
