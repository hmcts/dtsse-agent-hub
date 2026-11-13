"use client";

import { startTransition, useEffect } from "react";
import { useHubEvent } from "@/components/live/HubStream";
import { useSettled } from "@/components/live/useSettled";
import type { ActionResult } from "@/web/action";

/**
 * Marks the project seen by the viewer once its page is on screen, and again as something new arrives while it is,
 * so what they watched arrive is not counted as new once they leave. From the browser rather than as the page
 * renders, so a prefetch of the page marks nothing. A failure is not reported: the count stays, which is all it costs.
 */
export function MarkSeen({ projectId, markSeen }: Readonly<{ projectId: string; markSeen: (input: { projectId: unknown }) => Promise<ActionResult> }>) {
  const { settle } = useSettled(() => startTransition(() => void markSeen({ projectId }).catch(() => undefined)));
  useEffect(() => {
    startTransition(() => void markSeen({ projectId }).catch(() => undefined));
  }, [projectId, markSeen]);
  useHubEvent<{ project_id: string }>("feedback", (data) => {
    if (data.project_id === projectId) {
      settle();
    }
  });
  return null;
}
