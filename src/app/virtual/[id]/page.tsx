import { notFound } from "next/navigation";
import { sendDirect } from "@/app/_actions/direct";
import { deleteVirtualAgent, pasteLoginCode, startVirtualAgent, stopVirtualAgent } from "@/app/_actions/virtual-agents";
import { Conversation } from "@/components/agents/Conversation";
import { EmptyState } from "@/components/EmptyState";
import { PaneHeader } from "@/components/Pane";
import { LifecyclePanel } from "@/components/virtual-agents/LifecyclePanel";
import { statusLabel } from "@/components/virtual-agents/labels";
import { OnboardingChecklist } from "@/components/virtual-agents/OnboardingChecklist";
import { VirtualAgentRefresh } from "@/components/virtual-agents/VirtualAgentRefresh";
import { DiskNotice, ModelRouteLine } from "@/components/virtual-agents/VirtualAgentsView";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { virtualAgentPage } from "@/web/data";

export const dynamic = "force-dynamic";

/**
 * One of the viewer's own virtual agents: its lifecycle, the sign-ins it needs, and once its session has registered,
 * that agent's conversation. Anyone else's, or any id while the feature is off, is not found.
 */
export default async function VirtualAgentPage({ params }: { params: Promise<{ id: string }> }) {
  if (!virtualAgentsEnabled()) {
    notFound();
  }
  const viewer = await requireViewer();
  const { id } = await params;
  const page = await virtualAgentPage(viewer, id);
  if (page === undefined) {
    notFound();
  }
  const { detail, credentials, linked } = page;
  const agent = detail.card;
  const now = Date.now();

  const side = (
    <div className="space-y-4 p-4">
      <LifecyclePanel agent={agent} actions={{ start: startVirtualAgent, stop: stopVirtualAgent, remove: deleteVirtualAgent }} />
      {agent.desired === "stopped" ? <DiskNotice agent={agent} now={now} /> : null}
      <OnboardingChecklist
        virtualAgentId={agent.id}
        needed={detail.needed}
        statuses={credentials.available ? credentials.statuses : []}
        logins={detail.logins}
        paste={pasteLoginCode}
        now={now}
        {...(credentials.available ? {} : { unavailable: credentials.reason })}
      />
      <ModelRouteLine route={agent.modelRoute} />
    </div>
  );

  return (
    <>
      <VirtualAgentRefresh virtualAgentId={agent.id} />
      <PaneHeader title={agent.name} kind="Virtual agent" subtitle={statusLabel(agent.status, agent.desired)} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section aria-labelledby="conversation-heading" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <h2 id="conversation-heading" className="sr-only">
            Conversation
          </h2>
          {linked === null ? (
            <div className="p-5">
              <EmptyState message="No conversation yet." detail="It appears here once your virtual agent has started Claude." />
            </div>
          ) : (
            <Conversation
              agentId={linked.view.agent.id}
              agentName={linked.view.agent.name}
              ownerName={linked.view.agent.owner.name}
              status={linked.view.agent.status}
              access={linked.view.access}
              initial={linked.conversation}
              send={sendDirect}
            />
          )}
        </section>
        <aside
          aria-label="About this virtual agent"
          className="max-h-[50vh] shrink-0 overflow-y-auto border-t border-hub-line lg:max-h-none lg:w-96 lg:border-l lg:border-t-0"
        >
          {side}
        </aside>
      </div>
    </>
  );
}
