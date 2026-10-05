import { notFound } from "next/navigation";
import { createVirtualAgent } from "@/app/_actions/virtual-agents";
import { PaneBody, PaneHeader } from "@/components/Pane";
import { VirtualAgentRefresh } from "@/components/virtual-agents/VirtualAgentRefresh";
import { VirtualAgentsView } from "@/components/virtual-agents/VirtualAgentsView";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { virtualAgentsPage } from "@/web/data";

export const dynamic = "force-dynamic";

/** The viewer's own virtual agents, and the form to create one. Not found while the feature is off. */
export default async function VirtualAgentsPage() {
  if (!virtualAgentsEnabled()) {
    notFound();
  }
  const viewer = await requireViewer();
  const page = await virtualAgentsPage(viewer);
  return (
    <>
      <VirtualAgentRefresh />
      <PaneHeader title="Virtual agents" subtitle="Claude Code sessions the hub runs for you" />
      <PaneBody>
        <VirtualAgentsView agents={page.agents} route={page.modelRoute} create={createVirtualAgent} now={Date.now()} />
      </PaneBody>
    </>
  );
}
