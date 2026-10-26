// What this container's memory cgroup says, reported to the hub because the hub cannot see it: every call between the
// two is pod to hub. Each HMCTS Assistant conversation runs a Claude process of its own and brings its MCP servers
// with it, so a pod can reach the ceiling of its size with nothing wrong with it — and the figure that tells anyone
// that is the one the kernel would kill it at, which only the cgroup has.
import nodeFs from "node:fs";
import path from "node:path";
import type { MemoryReportBody } from "../api.ts";

/** Where cgroup v2 mounts in a pod. The container's own files are at the root of it: it is namespaced. */
export const CGROUP_ROOT = "/sys/fs/cgroup";

/** Only the three files this reads, so a test passes an object with one method rather than a filesystem. */
export type MemoryFs = Pick<typeof nodeFs, "readFileSync">;

export type MemoryOptions = {
  root?: string;
  fs?: MemoryFs;
  say?: (message: string) => void;
};

/**
 * One cgroup figure, or `undefined` when the file is missing, unreadable, or holds something that is not a count.
 * `max` is the kernel's word for "no limit", and is deliberately not turned into a number here.
 */
function reading(root: string, name: string, fs: MemoryFs): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(root, name), "utf8");
  } catch {
    return undefined;
  }
  // An empty or whitespace-only file is nothing, not zero: `Number("")` is 0, and a cgroup file read as 0 would be
  // shown to someone as a measurement.
  const text = raw.trim();
  const value = Number(text);
  return text !== "" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Reads `memory.max`, `memory.current` and `memory.peak`.
 *
 * `undefined` when any one of them cannot be read, which covers a pod on cgroup v1, a kernel without `memory.peak`,
 * and a container with no limit at all (`memory.max` is the literal `max`). Nothing partial is sent: every sentence
 * the hub writes about this is relative to the limit, so a limit filled in from the size would be a figure presented
 * as measured, and the hub's three "we cannot tell" states are worth more than a guess.
 */
export function measureMemory({ root = CGROUP_ROOT, fs = nodeFs, say = () => {} }: MemoryOptions = {}): MemoryReportBody | undefined {
  const limit = reading(root, "memory.max", fs);
  const current = reading(root, "memory.current", fs);
  const peak = reading(root, "memory.peak", fs);
  if (limit === undefined || current === undefined || peak === undefined) {
    say(`could not read this container's memory cgroup under ${root}`);
    return undefined;
  }
  return { limit_bytes: limit, current_bytes: current, peak_bytes: peak };
}

export type ReportMemoryOptions = MemoryOptions & {
  api: { putMemory: (virtualId: string, body: MemoryReportBody) => Promise<null> };
  id: string;
};

/**
 * Measures and reports. Answers what it sent, or `undefined` when there was nothing to send or the hub refused it.
 *
 * A failed report is not retried, as a disk report is not: the next reconcile measures again, and the hub always says
 * when the pod last reported rather than presenting the figures as current. `memory.peak` is monotonic while the pod
 * is up, so a report that was lost costs a late peak and never a wrong one.
 */
export async function reportMemory({ api, id, ...options }: ReportMemoryOptions): Promise<MemoryReportBody | undefined> {
  const say = options.say ?? (() => {});
  const measured = measureMemory(options);
  if (measured === undefined) {
    return undefined;
  }
  try {
    await api.putMemory(id, measured);
    return measured;
  } catch (e) {
    say(`could not report this container's memory: ${(e as Error).message}`);
    return undefined;
  }
}
