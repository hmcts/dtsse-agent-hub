"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import { useHubEvent } from "@/components/live/HubStream";

/**
 * Re-renders the server components when an agent the viewer can see, but the sidebar does not list, changes status:
 * that is a newly registered agent, or one a new grant has made visible.
 */
export function NewAgentWatcher({ known }: { known: readonly string[] }) {
  const router = useRouter();
  const pending = useRef(false);
  useHubEvent<{ agent_id: string }>("agent_status", ({ agent_id }) => {
    if (!known.includes(agent_id) && !pending.current) {
      pending.current = true;
      setTimeout(() => {
        pending.current = false;
        router.refresh();
      }, 500);
    }
  });
  return null;
}
