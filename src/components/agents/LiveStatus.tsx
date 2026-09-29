"use client";

import { useState } from "react";
import { useHubEvent } from "@/components/live/HubStream";
import { StatusDot } from "@/components/StatusDot";
import type { AgentStatus } from "@/realtime/events";

/** An agent's status as the stream reports it, starting from the status the page was rendered with. */
export function useLiveStatus(agentId: string, initial: AgentStatus): AgentStatus {
  const [status, setStatus] = useState(initial);
  useHubEvent<{ agent_id: string; status: AgentStatus }>("agent_status", (event) => {
    if (event.agent_id === agentId) {
      setStatus(event.status);
    }
  });
  return status;
}

/** An agent's status that follows the stream. */
export function LiveStatus({ agentId, initial, labelled = false }: { agentId: string; initial: AgentStatus; labelled?: boolean }) {
  return <StatusDot status={useLiveStatus(agentId, initial)} labelled={labelled} />;
}
