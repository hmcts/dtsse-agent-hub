"use client";

import { useRouter } from "next/navigation";
import { useHubEvent } from "@/components/live/HubStream";
import { useSettled } from "@/components/live/useSettled";

/**
 * Re-reads a team feedback page when something of its project changes: a comment, a reply, a recording, the project
 * itself. The stream sends `feedback` only to the project's team, with ids alone, so the page reads what changed
 * under its own rule. Without `projectId`, as on the list of projects, any of the viewer's projects counts.
 */
export function FeedbackRefresh({ projectId }: Readonly<{ projectId?: string }>) {
  const router = useRouter();
  const { settle } = useSettled(() => router.refresh());
  useHubEvent<{ project_id: string }>("feedback", (data) => {
    if (projectId === undefined || data.project_id === projectId) {
      settle();
    }
  });
  useHubEvent("resync", settle);
  return null;
}
