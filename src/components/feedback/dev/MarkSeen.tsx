"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import { useHubEvent } from "@/components/live/HubStream";
import { useSettled } from "@/components/live/useSettled";
import type { ActionResult } from "@/web/action";

/**
 * Marks the project seen by the viewer once its page is on screen, and again as something new arrives while it is,
 * so what they watched arrive is not counted as new once they leave. From the browser rather than as the page
 * renders, so a prefetch of the page marks nothing; and only while the tab is visible, so a page left open in a
 * background tab does not mark as seen what nobody has looked at. A failure is not reported: the count stays, which
 * is all it costs.
 *
 * The action is held in a ref rather than keyed on: each render of the page hands down a new function for it, and
 * the action re-renders the page, so keying on it would mark seen again on every render.
 */
export function MarkSeen({ projectId, markSeen }: Readonly<{ projectId: string; markSeen: (input: { projectId: unknown }) => Promise<ActionResult> }>) {
  const action = useRef(markSeen);
  action.current = markSeen;
  const [arrivals, setArrivals] = useState(0);
  const { settle } = useSettled(() => setArrivals((count) => count + 1));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `arrivals` is what marks it seen again
  useEffect(() => {
    const mark = () => startTransition(() => void action.current({ projectId }).catch(() => undefined));
    if (document.visibilityState === "visible") {
      mark();
      return;
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", onVisible);
        mark();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [projectId, arrivals]);
  useHubEvent<{ project_id: string }>("feedback", (data) => {
    if (data.project_id === projectId) {
      settle();
    }
  });
  return null;
}
