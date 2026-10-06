import type { FormAction } from "@/components/ActionForm";
import { DevBadge } from "@/components/DevBadge";
import { EmptyState } from "@/components/EmptyState";
import { type LifecycleActions, LifecyclePanel } from "@/components/virtual-agents/LifecyclePanel";
import { OnboardingChecklist } from "@/components/virtual-agents/OnboardingChecklist";
import { PortsPanel } from "@/components/virtual-agents/PortsPanel";
import { RenameVirtualAgent } from "@/components/virtual-agents/RenameVirtualAgent";
import { SizePanel } from "@/components/virtual-agents/SizePanel";
import { DiskNotice, ModelRouteLine } from "@/components/virtual-agents/VirtualAgentsView";
import type { VirtualAgentDesired } from "@/virtual-agents/lifecycle";
import type { VirtualAgentPageView } from "@/web/data";

export interface VirtualAgentActions {
  lifecycle: LifecycleActions;
  rename: FormAction;
  resize: FormAction;
  paste: FormAction;
  reconnect: FormAction;
  save: FormAction;
}

function OwnerPanels({ manage, actions, now }: { manage: NonNullable<VirtualAgentPageView["manage"]>; actions: VirtualAgentActions; now: number }) {
  const { detail, credentials } = manage;
  const agent = detail.card;
  return (
    <>
      <LifecyclePanel agent={agent} actions={actions.lifecycle} />
      {agent.desired === "stopped" ? <DiskNotice agent={agent} now={now} /> : null}
      <RenameVirtualAgent agent={agent} rename={actions.rename} />
      <SizePanel agent={agent} resize={actions.resize} />
      <PortsPanel agent={agent} />
      <OnboardingChecklist
        virtualAgentId={agent.id}
        desired={agent.desired}
        needed={detail.needed}
        optional={detail.optional}
        statuses={credentials.available ? credentials.statuses : []}
        logins={detail.logins}
        paste={actions.paste}
        save={actions.save}
        reconnect={actions.reconnect}
        now={now}
        {...(credentials.available ? {} : { unavailable: credentials.reason })}
      />
      <ModelRouteLine route={agent.modelRoute} />
    </>
  );
}

/**
 * A virtual agent's side panel. Its owner gets its lifecycle, name, size, ports and sign-ins; anyone else who may see
 * it is told whose it is. Either way the current session's details follow, once a session has registered.
 */
export function VirtualAgentPanel({
  page,
  actions,
  now,
  session
}: {
  page: VirtualAgentPageView;
  actions: VirtualAgentActions;
  now: number;
  session: React.ReactNode;
}) {
  const { summary, manage } = page;
  return (
    <>
      <div className="space-y-4 border-b border-hub-line p-4">
        {manage === null ? (
          <p className="text-[13px] text-hub-text">
            A virtual agent the hub runs for {summary.owner.name}
            <DevBadge tid={summary.owner.tid} />
          </p>
        ) : (
          <OwnerPanels manage={manage} actions={actions} now={now} />
        )}
      </div>
      {session}
    </>
  );
}

/** Where the conversation goes before the virtual agent's first session has registered. */
export function VirtualAgentPending({ desired }: { desired: VirtualAgentDesired }) {
  return (
    <div className="p-5">
      {desired === "running" ? (
        <EmptyState message="Starting…" detail="The conversation appears once Claude has started." />
      ) : desired === "stopped" ? (
        <EmptyState message="No conversation yet." detail="It appears once the virtual agent is started and Claude is running." />
      ) : (
        <EmptyState message="No conversation." />
      )}
    </div>
  );
}
