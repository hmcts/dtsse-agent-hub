"use client";

import { useState } from "react";
import type { AgentCard } from "@/agents/views";
import { Avatar } from "@/components/Avatar";
import { DevBadge } from "@/components/DevBadge";
import { useHubEvent } from "@/components/live/HubStream";
import { NavLink } from "@/components/NavLink";
import type { AgentStatus } from "@/realtime/events";

const RANK: Record<AgentStatus, number> = { busy: 0, idle: 1, offline: 2 };

function byStatusThenName(statuses: Record<string, AgentStatus>) {
  return (left: AgentCard, right: AgentCard): number => {
    const rank = RANK[statuses[left.id] ?? left.status] - RANK[statuses[right.id] ?? right.status];
    return rank !== 0 ? rank : left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  };
}

function Row({ agent, status, showOwner }: { agent: AgentCard; status: AgentStatus; showOwner: boolean }) {
  const offline = status === "offline";
  return (
    <li>
      <NavLink href={`/agents/${agent.id}`} className={offline ? "opacity-60" : ""}>
        <span className="relative">
          <Avatar name={agent.name} size="sm" />
          <span
            aria-hidden="true"
            data-status={status}
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-hub-rail ${
              status === "busy" ? "bg-status-busy" : status === "idle" ? "bg-status-idle" : "bg-status-offline"
            }`}
          />
        </span>
        <span className="truncate">{agent.name}</span>
        <span className="sr-only">{status}</span>
        {showOwner ? (
          <span className="ml-auto truncate text-xs text-hub-muted">
            {agent.owner.name}
            <DevBadge tid={agent.owner.tid} />
          </span>
        ) : null}
      </NavLink>
    </li>
  );
}

/**
 * The viewer's agents and those shared with them, connected ones first. Statuses follow the stream, so an agent
 * that goes offline sinks below those still working.
 */
export function AgentRoster({ mine, shared }: { mine: AgentCard[]; shared: AgentCard[] }) {
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  useHubEvent<{ agent_id: string; status: AgentStatus }>("agent_status", ({ agent_id, status }) => {
    setStatuses((current) => ({ ...current, [agent_id]: status }));
  });

  const all = [...mine.map((agent) => ({ agent, shared: false })), ...shared.map((agent) => ({ agent, shared: true }))];
  const order = byStatusThenName(statuses);
  all.sort((left, right) => order(left.agent, right.agent));
  const connected = all.filter(({ agent }) => (statuses[agent.id] ?? agent.status) !== "offline").length;

  return (
    <section aria-labelledby="sidebar-agents" className="max-h-[45%] shrink-0 overflow-y-auto border-t border-hub-line py-3">
      <h2 id="sidebar-agents" className="flex items-baseline gap-2 px-5 pb-1 text-[15px] text-hub-muted">
        Agents
        <span className="text-xs">{all.length === 0 ? "" : `${connected} connected`}</span>
      </h2>
      {mine.length === 0 ? <p className="px-5 text-xs text-hub-muted">None yet. Run /enable-comms in a Claude Code session.</p> : null}
      {all.length === 0 ? <p className="px-5 pt-1 text-xs text-hub-muted">Nobody has granted you access.</p> : null}
      {all.length > 0 ? (
        <ul aria-label="Agents">
          {all.map(({ agent, shared: isShared }) => (
            <Row key={agent.id} agent={agent} status={statuses[agent.id] ?? agent.status} showOwner={isShared} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
