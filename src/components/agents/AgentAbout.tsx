import type { AgentView } from "@/agents/views";
import { LastHeard } from "@/components/agents/LastHeard";
import { DevBadge } from "@/components/DevBadge";
import { Timestamp } from "@/components/time/Timestamp";

const ACCESS_LABEL = { owner: "You own this agent", write: "You have write access", read: "You have read access" } as const;

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-bold text-hub-muted">{term}</dt>
      <dd className="break-all font-mono text-[13px] text-hub-text">{children}</dd>
    </div>
  );
}

/**
 * Who owns an agent, where it runs, and what it last posted. The agent page shows it twice, as a side panel on wide
 * screens and a collapsed disclosure above the thread on narrow ones; only one is displayed at a time, so only one is
 * in the accessibility tree.
 */
export function AgentAbout({
  agent,
  access,
  ownedByViewer,
  latestPosts
}: {
  agent: AgentView["agent"];
  access: AgentView["access"];
  ownedByViewer: boolean;
  latestPosts: React.ReactNode;
}) {
  return (
    <>
      <div className="space-y-3 border-b border-hub-line px-4 py-4">
        <h2 className="text-[15px] font-bold text-white">About</h2>
        <p className="text-[13px] text-hub-text">
          Owned by {ownedByViewer ? "you" : agent.owner.name}
          <DevBadge tid={agent.owner.tid} />
          <br />
          <span className="text-hub-muted">{ACCESS_LABEL[access]}</span>
        </p>
        <dl className="space-y-2.5">
          <Detail term="Repository">{agent.repo ?? "unknown"}</Detail>
          <Detail term="Branch">{agent.branch ?? "unknown"}</Detail>
          <Detail term="Working directory">{agent.cwd ?? "unknown"}</Detail>
          <Detail term="Host">{agent.host ?? "unknown"}</Detail>
          <Detail term="Last heartbeat">
            <LastHeard agentId={agent.id} status={agent.status} lastHeartbeatAt={agent.lastHeartbeatAt} />
          </Detail>
          <Detail term="Registered">
            <Timestamp iso={agent.createdAt} />
          </Detail>
        </dl>
      </div>
      <div className="px-4 py-4">
        <h2 className="pb-2 text-[15px] font-bold text-white">Latest posts</h2>
        {latestPosts}
      </div>
    </>
  );
}
