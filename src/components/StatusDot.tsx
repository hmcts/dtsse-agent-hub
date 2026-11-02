import type { AgentStatus } from "@/realtime/events";

/**
 * The look of an agent's status dot, wherever one is drawn: the shape and colour only, so each caller sets its own size.
 *
 * `busy` is a hollow ring in `idle`'s green: both are a connected session, and the ring says it is mid-turn by its shape,
 * so the difference survives without colour and without the pulse, which stops after a few cycles and never starts for
 * anyone who asks for reduced motion. The word beside the dot says the status too.
 */
export const STATUS_DOT: Record<AgentStatus, string> = {
  busy: "border-[1.5px] border-status-idle status-pulse",
  idle: "bg-status-idle",
  offline: "bg-status-offline"
};

/** An agent's status as a dot, with the word for screen readers. `labelled` prints the word as well. */
export function StatusDot({ status, labelled = false }: { status: AgentStatus; labelled?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" data-status={status} className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
      {labelled ? <span className="text-xs text-hub-muted">{status}</span> : <span className="sr-only">{status}</span>}
    </span>
  );
}
