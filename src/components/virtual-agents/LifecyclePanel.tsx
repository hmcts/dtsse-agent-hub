"use client";

import { useState } from "react";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { Section } from "@/components/Section";
import type { VirtualAgentCard } from "@/virtual-agents/views";
import { statusLabel, stopReasonLabel } from "./labels";

export interface LifecycleActions {
  start: FormAction;
  stop: FormAction;
  remove: FormAction;
}

const BUTTON = "rounded border border-hub-line px-3 py-1 text-sm text-hub-text hover:bg-hub-raised";
const DANGER = "rounded bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-600";

function Act({ action, id, label, className = BUTTON }: { action: FormAction; id: string; label: string; className?: string }) {
  return (
    <ActionForm action={action} label={label}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className={className}>
        {label}
      </button>
    </ActionForm>
  );
}

/** Deleting takes the agent's disk with it, so it asks once more before it is sent. */
function Delete({ action, id, name }: { action: FormAction; id: string; name: string }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className={BUTTON} onClick={() => setConfirming(true)}>
        Delete
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm deleting ${name}`}>
      <p className="text-sm text-red-200">Delete {name} and its disk? Anything not pushed is lost.</p>
      <Act action={action} id={id} label={`Delete ${name}`} className={DANGER} />
      <button type="button" className={BUTTON} onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </div>
  );
}

export function LifecyclePanel({ agent, actions }: { agent: VirtualAgentCard; actions: LifecycleActions }) {
  const deleting = agent.desired === "deleted";
  return (
    <Section heading="Lifecycle" detail={statusLabel(agent.status, agent.desired)}>
      <div className="space-y-3 text-sm">
        {agent.statusDetail ? <p className="text-hub-text">{agent.statusDetail}</p> : null}
        {agent.desired === "stopped" && agent.stopReason ? <p className="text-hub-muted">{stopReasonLabel(agent.stopReason)}</p> : null}
        {deleting ? (
          <p className="text-hub-muted">This virtual agent and its disk are being deleted.</p>
        ) : (
          <div className="flex flex-wrap items-start gap-3">
            {agent.desired === "running" ? (
              <Act action={actions.stop} id={agent.id} label="Stop" />
            ) : (
              <Act action={actions.start} id={agent.id} label="Start" />
            )}
            <Delete action={actions.remove} id={agent.id} name={agent.name} />
          </div>
        )}
      </div>
    </Section>
  );
}
