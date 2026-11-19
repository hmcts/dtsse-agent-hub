import type { ConversationRow } from "./conversation-row.ts";

/**
 * Whether a message to a pod conversation has to ask for a session. Only a `live` session the supervisor reports can
 * take it: the agent's `busy` or `idle` can be left over from a session that ran before the pod restarted, and a
 * conversation the supervisor's last report leaves out reads `null`, as does one it reports `starting` or `queued`.
 * Asking again for a session that is starting is harmless, since a wake already pending keeps its time.
 */
export function needsWake(agentStatus: string | undefined, sessionState: ConversationRow["sessionState"]): boolean {
  return sessionState !== "live" || (agentStatus !== "busy" && agentStatus !== "idle");
}
