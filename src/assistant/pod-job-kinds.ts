import { type PodJobKind, podJobRegistry } from "./pod-jobs.ts";

/**
 * Every pod-job kind this hub runs. A feature adds its kind here, defined with `definePodJobKind` in its own module,
 * and its pod handler to the client package's `POD_JOB_HANDLERS`; see "Pod jobs" in docs/agent-api.md. An explicit
 * list rather than registration on import, so what is registered never depends on which modules happened to load first.
 */
export const POD_JOB_KINDS: readonly PodJobKind[] = [];

export const POD_JOB_REGISTRY: ReadonlyMap<string, PodJobKind> = podJobRegistry(POD_JOB_KINDS);
