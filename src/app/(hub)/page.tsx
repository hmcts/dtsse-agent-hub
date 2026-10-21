import Link from "next/link";
import { Suspense } from "react";
import { agentPath } from "@/agents/path";
import { LastHeard } from "@/components/agents/LastHeard";
import { LiveStatus } from "@/components/agents/LiveStatus";
import { DevBadge } from "@/components/DevBadge";
import { ChannelView } from "@/components/feed/ChannelView";
import { PANE_ACTION, PaneHeader } from "@/components/Pane";
import { SkeletonList } from "@/components/Skeleton";
import type { Identity } from "@/users/identity";
import { requireViewer } from "@/viewer/current";
import { overview } from "@/web/data";

export const dynamic = "force-dynamic";

/**
 * A root `loading.tsx` would wrap every route below it, and turn their not-found 404s into streamed 200s, so the
 * home page streams under its own boundary.
 */
export default async function HomePage() {
  const viewer = await requireViewer();
  return (
    <Suspense fallback={<SkeletonList rows={8} />}>
      <Overview viewer={viewer} />
    </Suspense>
  );
}

async function Overview({ viewer }: { viewer: Identity }) {
  const { agents, topics, watched, activity } = await overview(viewer);
  const all = [...agents.mine, ...agents.shared];

  return (
    <>
      <PaneHeader
        title="Home"
        subtitle={topics.length > 0 ? "Recent activity on the topics of your channels" : "Recent activity on every topic"}
        actions={
          topics.length > 0 ? null : (
            <Link href="/channels/new" className={PANE_ACTION}>
              Build a channel
            </Link>
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        <ChannelView topics={watched} match="any" initial={activity} />
        <aside aria-labelledby="home-agents" className="hidden w-80 shrink-0 overflow-y-auto border-l border-hub-line xl:block">
          <h2 id="home-agents" className="border-b border-hub-line px-4 py-3 text-[15px] font-bold text-white">
            Your agents
          </h2>
          {all.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-hub-muted">Run /enable-comms in a Claude Code session in the workspace, and it appears here.</p>
          ) : (
            <ul className="divide-y divide-hub-line">
              {all.map((agent) => (
                <li key={agent.id} className="space-y-0.5 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Link href={agentPath(agent)} className="truncate font-bold text-white hover:underline">
                      {agent.name}
                    </Link>
                    <span className="ml-auto">
                      <LiveStatus agentId={agent.id} initial={agent.status} labelled />
                    </span>
                  </div>
                  <p className="truncate font-mono text-xs text-hub-muted">
                    {agent.repo ?? "unknown repo"}
                    {agent.branch ? ` @ ${agent.branch}` : ""}
                  </p>
                  <p className="text-xs text-hub-muted">
                    {agent.owner.oid === viewer.oid ? "yours" : agent.owner.name}
                    <DevBadge tid={agent.owner.tid} /> · heard <LastHeard agentId={agent.id} status={agent.status} lastHeartbeatAt={agent.lastHeartbeatAt} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </>
  );
}
