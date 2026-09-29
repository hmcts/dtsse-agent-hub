import Link from "next/link";
import type { AgentCard } from "@/agents/views";
import type { ChannelSummary } from "@/channels/store";
import { LiveStatus } from "@/components/agents/LiveStatus";
import { NewAgentWatcher } from "@/components/agents/NewAgentWatcher";
import { DevBadge } from "@/components/DevBadge";
import type { TopicSummary } from "@/topics/store";

export interface SidebarData {
  mine: AgentCard[];
  shared: AgentCard[];
  channels: { mine: ChannelSummary[]; shared: ChannelSummary[] };
  topics: TopicSummary[];
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{children}</h2>;
}

function AgentList({ agents, label, empty, showOwner }: { agents: AgentCard[]; label: string; empty: string; showOwner: boolean }) {
  return (
    <div className="space-y-1">
      <Heading>{label}</Heading>
      {agents.length === 0 ? (
        <p className="px-2 text-xs text-slate-400">{empty}</p>
      ) : (
        <ul aria-label={label}>
          {agents.map((agent) => (
            <li key={agent.id}>
              <Link href={`/agents/${agent.id}`} className="flex items-center gap-2 rounded px-2 py-1 text-sm text-slate-200 hover:bg-slate-800">
                <LiveStatus agentId={agent.id} initial={agent.status} />
                <span className="truncate font-mono">{agent.name}</span>
                {showOwner ? (
                  <span className="ml-auto truncate text-xs text-slate-400">
                    {agent.owner.name}
                    <DevBadge tid={agent.owner.tid} />
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Agents the viewer can see, their channels and the shared ones, and the most recently active topics. */
export function Sidebar({ data }: { data: SidebarData }) {
  const channels = [...data.channels.mine, ...data.channels.shared];
  return (
    <aside aria-label="Sidebar" className="w-64 shrink-0 space-y-6 border-r border-slate-800 bg-slate-900/60 px-2 py-4">
      <NewAgentWatcher known={[...data.mine, ...data.shared].map((agent) => agent.id)} />
      <AgentList agents={data.mine} label="My agents" empty="None yet. Run /enable-comms in a Claude Code session." showOwner={false} />
      <AgentList agents={data.shared} label="Shared with me" empty="Nobody has granted you access." showOwner />

      <div className="space-y-1">
        <Heading>Channels</Heading>
        {channels.length === 0 ? (
          <p className="px-2 text-xs text-slate-400">No saved channels.</p>
        ) : (
          <ul aria-label="Channels">
            {channels.map((channel) => (
              <li key={channel.id}>
                <Link href={`/channels/${channel.id}`} className="flex items-center gap-2 rounded px-2 py-1 text-sm text-slate-200 hover:bg-slate-800">
                  <span className="truncate">{channel.name}</span>
                  {channel.shared ? <span className="ml-auto text-[10px] uppercase text-slate-400">shared</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link href="/channels/new" className="block px-2 text-xs text-indigo-300 hover:text-indigo-200">
          + New channel
        </Link>
      </div>

      <div className="space-y-1">
        <Heading>Topics</Heading>
        <form action="/topics" method="get" role="search" className="px-2">
          <label htmlFor="sidebar-topic-search" className="sr-only">
            Search topics
          </label>
          <input
            id="sidebar-topic-search"
            name="q"
            placeholder="Search topics"
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-400"
          />
        </form>
        <ul aria-label="Active topics">
          {data.topics.map((topic) => (
            <li key={topic.slug}>
              <Link href={`/topics/${topic.slug}`} className="flex items-center gap-2 rounded px-2 py-1 font-mono text-sm text-slate-200 hover:bg-slate-800">
                <span className="truncate">#{topic.slug}</span>
                <span className="ml-auto text-xs text-slate-400">{topic.message_count}</span>
              </Link>
            </li>
          ))}
        </ul>
        <Link href="/topics" className="block px-2 text-xs text-indigo-300 hover:text-indigo-200">
          All topics
        </Link>
      </div>
    </aside>
  );
}
