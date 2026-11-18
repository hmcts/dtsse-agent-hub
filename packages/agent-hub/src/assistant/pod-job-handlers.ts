import type { PodJobHandler } from "./pod-jobs.ts";

/**
 * Every pod-job kind this build runs, and so claims as `pod-job:<kind>`. A feature adds its handler here in the same
 * change as the hub's kind, so a pod never claims a kind it cannot run. An explicit list rather than registration on
 * import, so the claim never depends on which modules happened to load first.
 *
 * Imported by `features.ts` and so by everything that reports a claim: a handler's module should import its heavy
 * dependencies inside `run`, not at the top.
 */
export const POD_JOB_HANDLERS: readonly PodJobHandler[] = [];
