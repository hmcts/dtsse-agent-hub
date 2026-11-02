import type { VirtualAgentDesired, VirtualAgentStatus } from "@/virtual-agents/lifecycle";

/** How a virtual agent's state reads in the Assistant's settings. */

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

/**
 * The status, except that an agent being deleted says so whatever its pod last reported, and one meant to be stopped
 * reads as stopping until it is stopped or has failed, whatever its status still says.
 */
export function statusLabel(status: VirtualAgentStatus, desired: VirtualAgentDesired): string {
  if (desired === "deleted") {
    return "Deleting";
  }
  if (desired === "stopped" && status !== "stopped" && status !== "failed") {
    return STATUS.stopping;
  }
  return STATUS[status];
}
