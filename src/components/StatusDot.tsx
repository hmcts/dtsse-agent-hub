import type { AgentStatus } from "@/realtime/events";

const COLOUR: Record<AgentStatus, string> = {
  busy: "bg-status-busy",
  idle: "bg-status-idle",
  offline: "bg-status-offline"
};

/** An agent's status as a dot, with the word for screen readers. `labelled` prints the word as well. */
export function StatusDot({ status, labelled = false }: { status: AgentStatus; labelled?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" data-status={status} className={`inline-block h-2 w-2 shrink-0 rounded-full ${COLOUR[status]}`} />
      {labelled ? <span className="text-xs text-hub-muted">{status}</span> : <span className="sr-only">{status}</span>}
    </span>
  );
}
