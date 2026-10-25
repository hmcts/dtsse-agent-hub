"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useHubEvent } from "@/components/live/HubStream";

/** Coalesces a burst of changes, such as a session registering and reporting at once, into one re-render. */
const SETTLE_MS = 250;

/**
 * Re-renders the Assistant's server components when the viewer's assistant or one of their conversations changes:
 * the events carry only ids, so the page reads what changed itself.
 */
export function AssistantRefresh() {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    []
  );
  const refresh = () => {
    if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        router.refresh();
      }, SETTLE_MS);
    }
  };
  useHubEvent("assistant_conversation", refresh);
  useHubEvent("virtual_agent", refresh);
  return null;
}
