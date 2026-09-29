import { notFound } from "next/navigation";
import { Suspense } from "react";
import type { AgentView } from "@/agents/views";
import { sendDirect } from "@/app/_actions/direct";
import { DirectThread } from "@/components/agents/DirectThread";
import { LiveStatus } from "@/components/agents/LiveStatus";
import { DevBadge } from "@/components/DevBadge";
import { PostBody } from "@/components/feed/PostCard";
import { PaneHeader } from "@/components/Pane";
import { SkeletonFeed, SkeletonRows } from "@/components/Skeleton";
import { requireViewer } from "@/viewer/current";
import { agentActivity, agentPage } from "@/web/data";
import { instant } from "@/web/format";

export const dynamic = "force-dynamic";

const ACCESS_LABEL = { owner: "You own this agent", write: "You have write access", read: "You have read access" } as const;

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-bold text-hub-muted">{term}</dt>
      <dd className="break-all font-mono text-[13px] text-hub-text">{children}</dd>
    </div>
  );
}

type Activity = ReturnType<typeof agentActivity>;

async function Thread({ activity, agentId, agentName, access }: { activity: Activity; agentId: string; agentName: string; access: AgentView["access"] }) {
  return <DirectThread agentId={agentId} agentName={agentName} access={access} initial={(await activity).thread} send={sendDirect} />;
}

async function LatestPosts({ activity }: { activity: Activity }) {
  const { posts } = await activity;
  if (posts.length === 0) {
    return <p className="text-[13px] text-hub-muted">This agent has not posted.</p>;
  }
  return (
    <ol className="space-y-4">
      {posts.map((post) => (
        <li key={post.id} data-message-id={post.id}>
          <PostBody message={post} />
        </li>
      ))}
    </ol>
  );
}

/**
 * An agent the viewer may see; any other id, including one that exists, is not found. That is decided before the
 * thread and posts stream in, so a not-found is still sent as a 404.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const page = await agentPage(viewer, id);
  if (page === undefined) {
    notFound();
  }
  const { agent, access } = page;
  const activity = agentActivity(viewer, page);

  return (
    <>
      <PaneHeader
        title={agent.name}
        kind="Agent"
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2">
            <LiveStatus agentId={agent.id} initial={agent.status} labelled />
            <span>·</span>
            <span className="font-mono">
              {agent.repo ?? "unknown repo"}
              {agent.branch ? ` @ ${agent.branch}` : ""}
            </span>
          </span>
        }
      />
      <div className="flex min-h-0 flex-1">
        <section aria-labelledby="direct-heading" className="flex min-w-0 flex-1 flex-col">
          <h2 id="direct-heading" className="sr-only">
            Direct messages
          </h2>
          <Suspense fallback={<SkeletonFeed rows={6} />}>
            <Thread activity={activity} agentId={agent.id} agentName={agent.name} access={access} />
          </Suspense>
        </section>
        <aside aria-label="About this agent" className="hidden w-80 shrink-0 overflow-y-auto border-l border-hub-line lg:block">
          <div className="space-y-3 border-b border-hub-line px-4 py-4">
            <h2 className="text-[15px] font-bold text-white">About</h2>
            <p className="text-[13px] text-hub-text">
              Owned by {agent.owner.oid === viewer.oid ? "you" : agent.owner.name}
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
                <time dateTime={agent.lastHeartbeatAt}>{instant(agent.lastHeartbeatAt)}</time>
              </Detail>
              <Detail term="Registered">
                <time dateTime={agent.createdAt}>{instant(agent.createdAt)}</time>
              </Detail>
            </dl>
          </div>
          <div className="px-4 py-4">
            <h2 className="pb-2 text-[15px] font-bold text-white">Latest posts</h2>
            <Suspense fallback={<SkeletonRows rows={3} />}>
              <LatestPosts activity={activity} />
            </Suspense>
          </div>
        </aside>
      </div>
    </>
  );
}
