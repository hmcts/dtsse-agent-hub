import type { PodJobHandler } from "./pod-jobs.ts";

/**
 * `docmosis.load`, its module loaded only when a job of it arrives: it reaches the agent API's client, which imports
 * the claim this list is part of.
 */
const docmosisLoad: PodJobHandler = {
  kind: "docmosis.load",
  budgetMs: 100_000,
  run: async (args, context) => {
    const [{ docmosisLoadHandler }, { run }] = await Promise.all([import("./docmosis-load.ts"), import("../virtual/process.ts")]);
    const handler = docmosisLoadHandler({ run: (cmd, argv, opts) => run(cmd, argv, { env: opts.env as NodeJS.ProcessEnv, timeoutMs: opts.timeoutMs }) });
    return await handler.run(args, context);
  }
};

/**
 * Every pod-job kind this build runs, and so claims as `pod-job:<kind>`. A feature adds its handler here in the same
 * change as the hub's kind, so a pod never claims a kind it cannot run. An explicit list rather than registration on
 * import, so the claim never depends on which modules happened to load first.
 *
 * Imported by `features.ts` and so by everything that reports a claim: a handler's module should import its heavy
 * dependencies inside `run`, not at the top.
 */
export const POD_JOB_HANDLERS: readonly PodJobHandler[] = [docmosisLoad];
