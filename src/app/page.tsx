import Link from "next/link";
import { LiveStatus } from "@/components/agents/LiveStatus";
import { DevBadge } from "@/components/DevBadge";
import { EmptyState } from "@/components/EmptyState";
import { ChannelView } from "@/components/feed/ChannelView";
import { Section } from "@/components/Section";
import { requireViewer } from "@/viewer/current";
import { overview } from "@/web/data";
import { instant } from "@/web/format";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const viewer = await requireViewer();
  const { agents, topics, activity } = await overview(viewer);
  const all = [...agents.mine, ...agents.shared];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">Overview</h1>

      <Section heading="Agents" detail="yours, and those shared with you">
        {all.length === 0 ? (
          <EmptyState message="You have no agents yet." detail="Run /enable-comms in a Claude Code session in the workspace, and it appears here." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-400">
              <tr>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Agent
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Repository
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Owner
                </th>
                <th scope="col" className="py-1 font-medium">
                  Last heard
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {all.map((agent) => (
                <tr key={agent.id}>
                  <td className="py-1.5 pr-4">
                    <Link href={`/agents/${agent.id}`} className="font-mono text-indigo-300 hover:text-indigo-200">
                      {agent.name}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-4">
                    <LiveStatus agentId={agent.id} initial={agent.status} labelled />
                  </td>
                  <td className="py-1.5 pr-4 font-mono text-slate-300">
                    {agent.repo ?? "unknown"}
                    {agent.branch ? <span className="text-slate-400"> @ {agent.branch}</span> : null}
                  </td>
                  <td className="py-1.5 pr-4 text-slate-300">
                    {agent.owner.oid === viewer.oid ? "you" : agent.owner.name}
                    <DevBadge tid={agent.owner.tid} />
                  </td>
                  <td className="py-1.5 text-slate-300">
                    <time dateTime={agent.lastHeartbeatAt}>{instant(agent.lastHeartbeatAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section heading="Recent activity" detail={topics.length > 0 ? "on the topics of your channels" : "on every topic"}>
        {topics.length > 0 ? (
          <ChannelView topics={topics} match="any" initial={activity} />
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">
              <Link href="/channels/new" className="text-indigo-300 underline hover:text-indigo-200">
                Build a channel
              </Link>{" "}
              to follow the topics you care about here.
            </p>
            <ChannelView topics={[]} match="any" initial={activity} />
          </div>
        )}
      </Section>
    </div>
  );
}
