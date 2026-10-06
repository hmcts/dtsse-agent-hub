import { notFound } from "next/navigation";
import { Suspense } from "react";
import type { AgentView } from "@/agents/views";
import { sendDirect } from "@/app/_actions/direct";
import { AgentAbout } from "@/components/agents/AgentAbout";
import { Conversation } from "@/components/agents/Conversation";
import { LiveStatus } from "@/components/agents/LiveStatus";
import { PostBody } from "@/components/feed/PostCard";
import { PaneHeader } from "@/components/Pane";
import { SkeletonFeed, SkeletonRows } from "@/components/Skeleton";
import { requireViewer } from "@/viewer/current";
import { agentActivity, agentPage } from "@/web/data";

export const dynamic = "force-dynamic";

type Activity = ReturnType<typeof agentActivity>;

async function AgentConversation({
  activity,
  agent,
  access,
  skills
}: {
  activity: Activity;
  agent: AgentView["agent"];
  access: AgentView["access"];
  skills: AgentView["skills"];
}) {
  return (
    <Conversation
      agentId={agent.id}
      agentName={agent.name}
      ownerName={agent.owner.name}
      status={agent.status}
      access={access}
      initial={(await activity).conversation}
      skills={skills}
      send={sendDirect}
    />
  );
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
  const { agent, access, skills } = page;
  const activity = agentActivity(viewer, page);
  const about = (
    <AgentAbout
      agent={agent}
      access={access}
      ownedByViewer={agent.owner.oid === viewer.oid}
      latestPosts={
        <Suspense fallback={<SkeletonRows rows={3} />}>
          <LatestPosts activity={activity} />
        </Suspense>
      }
    />
  );

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
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <details className="max-h-[50vh] shrink-0 overflow-y-auto border-b border-hub-line lg:hidden">
          <summary className="cursor-pointer px-4 py-2 text-[13px] font-bold text-hub-link hover:bg-hub-raised">About this agent</summary>
          {about}
        </details>
        <section aria-labelledby="conversation-heading" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <h2 id="conversation-heading" className="sr-only">
            Conversation
          </h2>
          <Suspense fallback={<SkeletonFeed rows={6} />}>
            <AgentConversation activity={activity} agent={agent} access={access} skills={skills} />
          </Suspense>
        </section>
        <aside aria-label="About this agent" className="hidden w-80 shrink-0 overflow-y-auto border-l border-hub-line lg:block">
          {about}
        </aside>
      </div>
    </>
  );
}
