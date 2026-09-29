"use client";

import { useState } from "react";
import { useHubEvent } from "@/components/live/HubStream";
import { StatusDot } from "@/components/StatusDot";
import type { AgentStatus } from "@/realtime/events";

/** An agent's status that follows the stream. */
export function LiveStatus({ agentId, initial, labelled = false }: { agentId: string; initial: AgentStatus; labelled?: boolean }) {
  const [status, setStatus] = useState(initial);
  useHubEvent<{ agent_id: string; status: AgentStatus }>("agent_status", (event) => {
    if (event.agent_id === agentId) {
      setStatus(event.status);
    }
  });
  return <StatusDot status={status} labelled={labelled} />;
}
