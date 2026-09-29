"use client";

import { useState } from "react";
import { type Heard, lastHeard, onStatus } from "@/agents/liveness";
import { useHubEvent } from "@/components/live/HubStream";
import { Timestamp } from "@/components/time/Timestamp";
import { useNow } from "@/components/time/useNow";
import type { AgentStatus } from "@/realtime/events";
import { age } from "@/web/format";

/** Tracks when an agent was last heard from as its status follows the stream. */
export function useLastHeard(agentId: string, status: AgentStatus, lastHeartbeatAt: string): Heard {
  const [heard, setHeard] = useState<Heard>(() => ({ status, at: new Date(lastHeartbeatAt).getTime() }));
  useHubEvent<{ agent_id: string; status: AgentStatus }>("agent_status", (event) => {
    if (event.agent_id === agentId) {
      setHeard((current) => onStatus(current, event.status, Date.now()));
    }
  });
  return heard;
}

/** A heard-from time as an age, "3 min ago", once mounted; the server's absolute time until then. */
export function HeardAge({ heard, className }: { heard: Heard; className?: string }) {
  const now = useNow();
  const at = new Date(now === null ? heard.at : lastHeard(heard, now)).toISOString();
  return (
    <Timestamp iso={at} {...(className === undefined ? {} : { className })}>
      {now === null ? undefined : age(at, now)}
    </Timestamp>
  );
}

/** When an agent was last heard from, kept current by the stream and the clock. */
export function LastHeard({ agentId, status, lastHeartbeatAt }: { agentId: string; status: AgentStatus; lastHeartbeatAt: string }) {
  return <HeardAge heard={useLastHeard(agentId, status, lastHeartbeatAt)} />;
}
