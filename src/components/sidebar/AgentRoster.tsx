"use client";

import { useState } from "react";
import { type Heard, onStatus } from "@/agents/liveness";
import { agentPath } from "@/agents/path";
import type { AgentCard } from "@/agents/views";
import { Avatar } from "@/components/Avatar";
import { HeardAge } from "@/components/agents/LastHeard";
import { DevBadge } from "@/components/DevBadge";
import { useHubEvent } from "@/components/live/HubStream";
import { NavLink } from "@/components/NavLink";
import type { AgentStatus } from "@/realtime/events";
import { byCodePoint } from "@/topics/slug";

const RANK: Record<AgentStatus, number> = { busy: 0, idle: 1, offline: 2 };

function initialHeard(agent: AgentCard): Heard {
  return { status: agent.status, at: new Date(agent.lastHeartbeatAt).getTime() };
}

function byStatusThenName(statusOf: (agent: AgentCard) => AgentStatus) {
  return (left: AgentCard, right: AgentCard): number => {
    const rank = RANK[statusOf(left)] - RANK[statusOf(right)];
    return rank !== 0 ? rank : byCodePoint(left.name, right.name);
  };
}

function Row({ agent, heard, showOwner }: { agent: AgentCard; heard: Heard; showOwner: boolean }) {
  const { status } = heard;
  const offline = status === "offline";
  return (
    <li>
      <NavLink href={agentPath(agent)} className={offline ? "opacity-60" : ""}>
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
        {agent.virtualAgentId === null ? null : <span className="shrink-0 text-[10px] uppercase tracking-wide text-hub-muted">virtual</span>}
        <span className="sr-only">{status}</span>
        {showOwner || offline ? (
          <span className="ml-auto flex min-w-0 items-baseline gap-1.5 text-xs text-hub-muted">
            {showOwner ? (
              <span className="truncate">
                {agent.owner.name}
                <DevBadge tid={agent.owner.tid} />
              </span>
            ) : null}
            {offline ? (
              <span className="shrink-0 whitespace-nowrap">
                <span className="sr-only">, last heard </span>
                <HeardAge heard={heard} />
              </span>
            ) : null}
          </span>
        ) : null}
      </NavLink>
    </li>
  );
}

/**
 * The viewer's agents and those shared with them, connected ones first. Statuses follow the stream, so an agent
 * that goes offline sinks below those still working, and says how long it has been silent.
 */
export function AgentRoster({ mine, shared }: { mine: AgentCard[]; shared: AgentCard[] }) {
  const [heard, setHeard] = useState<Record<string, Heard>>({});
  const all = [...mine.map((agent) => ({ agent, shared: false })), ...shared.map((agent) => ({ agent, shared: true }))];
  const heardOf = (agent: AgentCard): Heard => heard[agent.id] ?? initialHeard(agent);

  useHubEvent<{ agent_id: string; status: AgentStatus }>("agent_status", ({ agent_id, status }) => {
    const known = all.find(({ agent }) => agent.id === agent_id)?.agent;
    if (known === undefined) {
      return;
    }
    setHeard((current) => ({ ...current, [agent_id]: onStatus(current[agent_id] ?? initialHeard(known), status, Date.now()) }));
  });

  const order = byStatusThenName((agent) => heardOf(agent).status);
  all.sort((left, right) => order(left.agent, right.agent));
  const connected = all.filter(({ agent }) => heardOf(agent).status !== "offline").length;

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
            <Row key={agent.id} agent={agent} heard={heardOf(agent)} showOwner={isShared} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
