import { EmptyState } from "@/components/EmptyState";
import { Section } from "@/components/Section";
import { Timestamp } from "@/components/time/Timestamp";
import type { ModelRoute } from "@/viewer/identity";
import { diskWarningDays } from "@/virtual-agents/cleanup";
import { MAX_PER_USER, MAX_RUNNING_PER_USER } from "@/virtual-agents/limits";
import type { VirtualAgentCard } from "@/virtual-agents/views";
import { type CreateAction, CreateVirtualAgentForm } from "./CreateVirtualAgentForm";
import { idleFor, statusLabel, stopReasonLabel } from "./labels";

export function ModelRouteLine({ route }: { route: ModelRoute }) {
  return (
    <p className="text-sm text-hub-text">
      Model: {route === "bedrock" ? "Amazon Bedrock, with your Bedrock API key" : "your own Claude licence, so it will also need your Claude token"}
    </p>
  );
}

/** The days left before a stopped agent's disk is deleted, once that is close, or that it has been. */
export function DiskNotice({ agent, now }: { agent: Pick<VirtualAgentCard, "diskExpiresAt" | "diskDeletedAt">; now: number }) {
  if (agent.diskDeletedAt !== null) {
    return <p className="text-xs text-hub-muted">Its disk has been deleted; starting it again begins from a fresh checkout.</p>;
  }
  const days = diskWarningDays(agent.diskExpiresAt === null ? null : new Date(agent.diskExpiresAt), new Date(now));
  if (days === undefined) {
    return null;
  }
  return (
    <p role="note" className="text-xs text-amber-300">
      Its disk will be deleted {days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}
      {agent.diskExpiresAt ? (
        <>
          {" "}
          (<Timestamp iso={agent.diskExpiresAt} />)
        </>
      ) : null}{" "}
      unless you start it again.
    </p>
  );
}

function Row({ agent, now }: { agent: VirtualAgentCard; now: number }) {
  const running = agent.desired === "running";
  return (
    <li className="space-y-1 border-b border-hub-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <a href={`/agents/${agent.id}`} className="font-bold text-hub-link hover:underline">
          {agent.name}
        </a>
        <span className="text-xs text-hub-muted">{statusLabel(agent.status, agent.desired)}</span>
        {running && agent.lastActivityAt ? <span className="text-xs text-hub-muted">idle for {idleFor(agent.lastActivityAt, now)}</span> : null}
      </div>
      {agent.statusDetail ? <p className="text-xs text-hub-text">{agent.statusDetail}</p> : null}
      {!running && agent.stopReason ? (
        <p className="text-xs text-hub-muted">
          {stopReasonLabel(agent.stopReason)}
          {agent.stoppedAt ? (
            <>
              {" "}
              <Timestamp iso={agent.stoppedAt} />
            </>
          ) : null}
        </p>
      ) : null}
      {agent.desired === "stopped" ? <DiskNotice agent={agent} now={now} /> : null}
    </li>
  );
}

export function CreateVirtualAgent({ route, create, refusal }: { route: ModelRoute; create: CreateAction; refusal?: string }) {
  return (
    <Section heading="Create a virtual agent">
      <div className="space-y-3 text-sm">
        <p role="note" className="rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-amber-200">
          A virtual agent acts with your GitHub and Azure access.
        </p>
        <ModelRouteLine route={route} />
        {refusal ? <p className="text-hub-muted">{refusal}</p> : <CreateVirtualAgentForm create={create} />}
      </div>
    </Section>
  );
}

/** Why another cannot be created, for the form to say instead of offering itself. */
export function createLimit(agents: readonly VirtualAgentCard[]): string | undefined {
  const live = agents.filter((agent) => agent.desired !== "deleted");
  if (live.length >= MAX_PER_USER) {
    return `You have ${MAX_PER_USER} virtual agents, the most anyone may have. Delete one to create another.`;
  }
  if (live.filter((agent) => agent.desired === "running").length >= MAX_RUNNING_PER_USER) {
    return `You have ${MAX_RUNNING_PER_USER} virtual agents running, the most anyone may run at once. Stop one to create another.`;
  }
  return undefined;
}

export function VirtualAgentsView({ agents, route, create, now }: { agents: VirtualAgentCard[]; route: ModelRoute; create: CreateAction; now: number }) {
  return (
    <>
      <Section heading="Your virtual agents" detail={`${agents.length} of ${MAX_PER_USER}`}>
        {agents.length === 0 ? (
          <EmptyState message="You have no virtual agents." detail="A virtual agent is a Claude Code session the hub runs for you in the cluster." />
        ) : (
          <ul aria-label="Your virtual agents" className="-m-4">
            {agents.map((agent) => (
              <Row key={agent.id} agent={agent} now={now} />
            ))}
          </ul>
        )}
      </Section>
      <CreateVirtualAgent route={route} create={create} refusal={createLimit(agents)} />
    </>
  );
}
