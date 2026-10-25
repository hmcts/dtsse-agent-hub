"use client";

import { useRouter } from "next/navigation";
import { useHubEvent } from "@/components/live/HubStream";

/** Re-reads the page whenever a virtual agent the viewer may see changes, since the event carries only its id. */
export function VirtualAgentRefresh({ virtualAgentId }: { virtualAgentId?: string }) {
  const router = useRouter();
  useHubEvent<{ virtual_agent_id: string }>("virtual_agent", ({ virtual_agent_id }) => {
    if (virtualAgentId === undefined || virtual_agent_id === virtualAgentId) {
      router.refresh();
    }
  });
  return null;
}
