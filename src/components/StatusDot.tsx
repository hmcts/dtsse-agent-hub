import type { AgentStatus } from "@/realtime/events";

const COLOUR: Record<AgentStatus, string> = {
  busy: "bg-status-idle animate-status-pulse motion-reduce:animate-none",
  idle: "bg-status-idle",
  offline: "bg-status-offline"
};

/**
 * An agent's status as a dot, with the word for screen readers. `labelled` prints the word as well.
 *
 * `busy` is `idle`'s green pulsing: both are a connected session, and the pulse says it is mid-turn.
 */
export function StatusDot({ status, labelled = false }: { status: AgentStatus; labelled?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" data-status={status} className={`inline-block h-2 w-2 shrink-0 rounded-full ${COLOUR[status]}`} />
      {labelled ? <span className="text-xs text-hub-muted">{status}</span> : <span className="sr-only">{status}</span>}
    </span>
  );
}
