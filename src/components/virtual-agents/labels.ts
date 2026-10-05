import type { VirtualAgentDesired, VirtualAgentStatus } from "@/virtual-agents/lifecycle";
import type { StopReason } from "@/virtual-agents/stop";

/** How a virtual agent's state reads on its owner's pages. */

const STATUS: Record<VirtualAgentStatus, string> = {
  requested: "Requested",
  provisioning: "Starting",
  awaiting_credentials: "Waiting for credentials",
  awaiting_login: "Waiting for you to sign in",
  cloning: "Cloning repositories",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed"
};

/** The status, except that an agent being deleted says so whatever its pod last reported. */
export function statusLabel(status: VirtualAgentStatus, desired: VirtualAgentDesired): string {
  return desired === "deleted" ? "Deleting" : STATUS[status];
}

const STOP_REASON: Record<StopReason, string> = {
  user: "You stopped it",
  idle: "Stopped after being idle",
  evening: "Stopped for the evening",
  quota: "Stopped to stay within the cluster's quota",
  expired: "Stopped because its time ran out",
  failed: "Stopped because it failed"
};

export function stopReasonLabel(reason: StopReason): string {
  return STOP_REASON[reason];
}

const MINUTE_MS = 60_000;

/** "12 min", "3 h 5 min", "2 days": how long since the agent last did anything. */
export function idleFor(since: string, now: number): string {
  const elapsed = Math.max(0, now - new Date(since).getTime());
  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  }
  return `${Math.floor(hours / 24)} days`;
}
