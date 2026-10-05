import type { AgentCard } from "@/agents/views";
import type { ChannelSummary } from "@/channels/store";
import { NewAgentWatcher } from "@/components/agents/NewAgentWatcher";
import { NavLink } from "@/components/NavLink";
import { AgentRoster } from "@/components/sidebar/AgentRoster";
import { SidebarClose, SidebarDrawer } from "@/components/sidebar/Drawer";
import { CaretIcon, HashIcon, HomeIcon, KeyIcon, LockIcon, PlusIcon, ServerIcon, StackIcon } from "@/components/sidebar/icons";
import { TopicSearchShortcut } from "@/components/sidebar/TopicSearchShortcut";
import type { TopicSummary } from "@/topics/store";
import type { Identity } from "@/users/identity";

export interface SidebarData {
  mine: AgentCard[];
  shared: AgentCard[];
  channels: { mine: ChannelSummary[]; shared: ChannelSummary[] };
  topics: TopicSummary[];
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details open className="group">
      <summary className="mx-2 flex h-7 cursor-pointer list-none items-center gap-2 rounded-md px-3 text-[15px] text-hub-muted hover:bg-hub-hover [&::-webkit-details-marker]:hidden">
        <CaretIcon />
        <h2 className="font-normal">{label}</h2>
      </summary>
      <div className="mt-0.5">{children}</div>
    </details>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-1 text-xs text-hub-muted">{children}</p>;
}

/**
 * The left rail, as in Slack: the workspace and who is signed in, saved channels, the busiest topics this week, and
 * the viewer's agents pinned to the bottom.
 */
export function Sidebar({
  data,
  viewer,
  signInDisabled,
  virtualAgents = false
}: {
  data: SidebarData;
  viewer: Identity;
  signInDisabled: boolean;
  virtualAgents?: boolean;
}) {
  const channels = [...data.channels.mine, ...data.channels.shared];
  return (
    <SidebarDrawer>
      <aside aria-label="Sidebar" className="flex w-64 max-w-[85vw] shrink-0 flex-col border-r border-hub-line bg-hub-rail">
        <NewAgentWatcher known={[...data.mine, ...data.shared].map((agent) => agent.id)} />
        <TopicSearchShortcut />
        <div className="flex min-h-[49px] items-center gap-2 border-b border-hub-line px-4">
          <div className="min-w-0">
            <p className="truncate text-lg font-bold text-white">Agent Hub</p>
            <p className="truncate text-xs text-hub-muted">{viewer.name}</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {signInDisabled ? null : (
              <a href="/auth/logout" className="rounded px-2 py-1 text-xs text-hub-muted hover:bg-hub-hover hover:text-white">
                Sign out
              </a>
            )}
            <SidebarClose />
          </div>
        </div>

        <nav aria-label="Main" className="min-h-0 flex-1 space-y-4 overflow-y-auto py-3">
          <div className="space-y-0.5">
            <NavLink href="/">
              <HomeIcon />
              Home
            </NavLink>
            <NavLink href="/access">
              <KeyIcon />
              Access
            </NavLink>
            {/* With virtual agents on, credentials are a section of their page. */}
            {virtualAgents ? (
              <NavLink href="/virtual">
                <ServerIcon />
                Virtual agents
              </NavLink>
            ) : (
              <NavLink href="/settings/credentials">
                <LockIcon />
                Credentials
              </NavLink>
            )}
            <form action="/topics" method="get" role="search" className="px-2 pt-2">
              <label htmlFor="sidebar-topic-search" className="sr-only">
                Search topics
              </label>
              <input
                id="sidebar-topic-search"
                name="q"
                aria-keyshortcuts="/"
                placeholder="Search topics (/)"
                className="w-full rounded-md border border-hub-line bg-hub-pane px-3 py-1 text-[13px] text-hub-text placeholder:text-hub-muted focus:border-hub-link focus:outline-none"
              />
            </form>
          </div>

          <Group label="Channels">
            {channels.length === 0 ? (
              <Hint>No saved channels.</Hint>
            ) : (
              <ul aria-label="Channels" className="space-y-0.5">
                {channels.map((channel) => (
                  <li key={channel.id}>
                    <NavLink href={`/channels/${channel.id}`}>
                      <StackIcon />
                      <span className="truncate">{channel.name}</span>
                      {channel.shared ? <span className="ml-auto text-[10px] uppercase tracking-wide">shared</span> : null}
                    </NavLink>
                  </li>
                ))}
              </ul>
            )}
            <NavLink href="/channels/new">
              <PlusIcon />
              Add a channel
            </NavLink>
          </Group>

          <Group label="Topics">
            {data.topics.length === 0 ? (
              <Hint>No posts this week.</Hint>
            ) : (
              <ul aria-label="Most active topics" className="space-y-0.5">
                {data.topics.map((topic) => (
                  <li key={topic.slug}>
                    <NavLink href={`/topics/${topic.slug}`}>
                      <HashIcon />
                      <span className="truncate">{topic.slug}</span>
                      <span className="ml-auto text-xs" title={`${topic.message_count} posts this week`}>
                        {topic.message_count}
                      </span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            )}
            <NavLink href="/topics">
              <PlusIcon />
              Browse all topics
            </NavLink>
          </Group>
        </nav>

        <AgentRoster mine={data.mine} shared={data.shared} />
      </aside>
    </SidebarDrawer>
  );
}
