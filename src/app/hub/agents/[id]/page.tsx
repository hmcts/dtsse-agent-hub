import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { repoFileBase } from "@/agents/github";
import type { AgentView } from "@/agents/views";
import { saveCredential } from "@/app/_actions/credentials";
import { sendDirect } from "@/app/_actions/direct";
import { answerAgentQuestion } from "@/app/_actions/questions";
import {
  deleteVirtualAgent,
  pasteLoginCode,
  reconnectSignIn,
  renameVirtualAgent,
  resizeVirtualAgent,
  setVirtualAgentPlugins,
  startVirtualAgent,
  stopVirtualAgent
} from "@/app/_actions/virtual-agents";
import { AgentAbout } from "@/components/agents/AgentAbout";
import { AgentLayout } from "@/components/agents/AgentLayout";
import { Conversation } from "@/components/agents/Conversation";
import { LiveStatus } from "@/components/agents/LiveStatus";
import { PostBody } from "@/components/feed/PostCard";
import { SkeletonFeed, SkeletonRows } from "@/components/Skeleton";
import { statusLabel } from "@/components/virtual-agents/labels";
import { type VirtualAgentActions, VirtualAgentPanel, VirtualAgentPending } from "@/components/virtual-agents/VirtualAgentPanel";
import { VirtualAgentRefresh } from "@/components/virtual-agents/VirtualAgentRefresh";
import { requireViewer } from "@/viewer/current";
import type { Viewer } from "@/viewer/identity";
import { agentActivity, agentRoute, pluginOffer, type VirtualAgentPageView } from "@/web/data";

export const dynamic = "force-dynamic";

type Activity = ReturnType<typeof agentActivity>;

const VIRTUAL_AGENT_ACTIONS: VirtualAgentActions = {
  lifecycle: { start: startVirtualAgent, stop: stopVirtualAgent, remove: deleteVirtualAgent },
  rename: renameVirtualAgent,
  resize: resizeVirtualAgent,
  plugins: setVirtualAgentPlugins,
  paste: pasteLoginCode,
  reconnect: reconnectSignIn,
  save: saveCredential
};

async function AgentConversation({ viewer, activity, view }: { viewer: Viewer; activity: Activity; view: AgentView }) {
  const { agent, skills } = view;
  const { conversation, questions } = await activity;
  return (
    <Conversation
      agentId={agent.id}
      agentName={agent.name}
      ownerName={agent.owner.name}
      virtualAgentId={agent.virtualAgentId}
      repoBase={repoFileBase(agent.repo, agent.branch)}
      viewerOid={viewer.oid}
      status={agent.status}
      initial={conversation}
      questions={questions}
      skills={skills}
      send={sendDirect}
      answerQuestion={answerAgentQuestion}
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

function About({ view, activity }: { view: AgentView; activity: Activity }) {
  return (
    <AgentAbout
      agent={view.agent}
      latestPosts={
        <Suspense fallback={<SkeletonRows rows={3} />}>
          <LatestPosts activity={activity} />
        </Suspense>
      }
    />
  );
}

function LocalAgent({ viewer, view }: { viewer: Viewer; view: AgentView }) {
  const { agent } = view;
  const activity = agentActivity(viewer, view);
  return (
    <AgentLayout
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
      side={<About view={view} activity={activity} />}
      sideLabel="About this agent"
      narrow="disclosure"
    >
      <Suspense fallback={<SkeletonFeed rows={6} />}>
        <AgentConversation viewer={viewer} activity={activity} view={view} />
      </Suspense>
    </AgentLayout>
  );
}

/**
 * The virtual agent and its current session. A `virtual_agent` event re-reads the page for anyone who may see it, so a
 * `/clear` brings the new session's conversation in without a reload.
 */
function VirtualAgent({ viewer, page }: { viewer: Viewer; page: VirtualAgentPageView }) {
  const { summary, linked } = page;
  const activity = linked === null ? null : agentActivity(viewer, linked);
  return (
    <>
      <VirtualAgentRefresh virtualAgentId={summary.id} />
      <AgentLayout
        title={summary.name}
        kind="Virtual agent"
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2">
            <span>{statusLabel(summary.status, summary.desired)}</span>
            {linked === null ? null : (
              <>
                <span>·</span>
                <LiveStatus agentId={linked.agent.id} initial={linked.agent.status} labelled />
              </>
            )}
          </span>
        }
        side={
          <VirtualAgentPanel
            page={page}
            actions={VIRTUAL_AGENT_ACTIONS}
            now={Date.now()}
            plugins={pluginOffer()}
            session={linked === null || activity === null ? null : <About view={linked} activity={activity} />}
          />
        }
        sideLabel="About this virtual agent"
        narrow="below"
      >
        {linked === null || activity === null ? (
          <VirtualAgentPending desired={summary.desired} />
        ) : (
          <Suspense key={linked.agent.id} fallback={<SkeletonFeed rows={6} />}>
            <AgentConversation viewer={viewer} activity={activity} view={linked} />
          </Suspense>
        )}
      </AgentLayout>
    </>
  );
}

/**
 * Every agent's page. A virtual agent's id shows the virtual agent and its current session; an agent one of its
 * sessions registered redirects there; any other agent is shown as itself. An id the viewer may not see, including
 * one that exists, is not found. That is decided before the thread and posts stream in, so a not-found is still sent
 * as a 404.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const route = await agentRoute(viewer, id);
  if (route === undefined) {
    notFound();
  }
  if (route.variant === "moved") {
    redirect(route.to);
  }
  return route.variant === "local" ? <LocalAgent viewer={viewer} view={route.view} /> : <VirtualAgent viewer={viewer} page={route.page} />;
}
