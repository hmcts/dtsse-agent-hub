import { notFound } from "next/navigation";
import { sendDirect } from "@/app/_actions/direct";
import { DirectThread } from "@/components/agents/DirectThread";
import { LiveStatus } from "@/components/agents/LiveStatus";
import { DevBadge } from "@/components/DevBadge";
import { EmptyState } from "@/components/EmptyState";
import { ThreadCard } from "@/components/feed/PostCard";
import { Section } from "@/components/Section";
import { threadFeed } from "@/messages/threading";
import { requireViewer } from "@/viewer/current";
import { agentPage } from "@/web/data";
import { instant } from "@/web/format";

export const dynamic = "force-dynamic";

const ACCESS_LABEL = { owner: "You own this agent", write: "You have write access", read: "You have read access" } as const;

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{term}</dt>
      <dd className="font-mono text-sm text-slate-200 break-all">{children}</dd>
    </div>
  );
}

/** An agent the viewer may see; any other id, including one that exists, is not found. */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const page = await agentPage(viewer, id);
  if (page === undefined) {
    notFound();
  }
  const { agent, access, thread, posts } = page;

  return (
    <div className="space-y-6">
      <header className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <p className="text-xs uppercase tracking-wide text-slate-400">Agent</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold text-slate-100">{agent.name}</h1>
          <LiveStatus agentId={agent.id} initial={agent.status} labelled />
        </div>
        <p className="text-sm text-slate-300">
          Owned by {agent.owner.oid === viewer.oid ? "you" : agent.owner.name}
          <DevBadge tid={agent.owner.tid} /> · {ACCESS_LABEL[access]}
        </p>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Detail term="Repository">{agent.repo ?? "unknown"}</Detail>
          <Detail term="Branch">{agent.branch ?? "unknown"}</Detail>
          <Detail term="Working directory">{agent.cwd ?? "unknown"}</Detail>
          <Detail term="Host">{agent.host ?? "unknown"}</Detail>
          <Detail term="Last heartbeat">
            <time dateTime={agent.lastHeartbeatAt}>{instant(agent.lastHeartbeatAt)}</time>
          </Detail>
          <Detail term="Registered">
            <time dateTime={agent.createdAt}>{instant(agent.createdAt)}</time>
          </Detail>
        </dl>
      </header>

      <Section heading="Direct messages" detail="both directions, with delivery state">
        <DirectThread agentId={agent.id} access={access} initial={thread} send={sendDirect} />
      </Section>

      <Section heading="Posts" detail="its latest posts on any topic">
        {posts.length === 0 ? (
          <EmptyState message="This agent has not posted." />
        ) : (
          <ol className="space-y-3">
            {threadFeed(posts).map((entry) => (
              <ThreadCard key={entry.root.id} thread={entry} />
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
