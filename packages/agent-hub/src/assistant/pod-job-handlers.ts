import { DOCMOSIS_LOAD_KIND, LOAD_BUDGET_MS } from "./docmosis-load-kind.ts";
import { loadNotify } from "./notify-tools.ts";
import { PodJobError, type PodJobHandler } from "./pod-jobs.ts";
import { VIDEO_ATTACH_BUDGET_MS, VIDEO_ATTACH_KIND } from "./video-attach-kind.ts";

/**
 * `docmosis.load`, its module loaded only when a job of it arrives: it reaches the agent API's client, which imports
 * the claim this list is part of.
 */
const docmosisLoad: PodJobHandler = {
  kind: DOCMOSIS_LOAD_KIND,
  budgetMs: LOAD_BUDGET_MS,
  run: async (args, context) => {
    const [{ docmosisLoadHandler }, { run }] = await Promise.all([import("./docmosis-load.ts"), import("../virtual/process.ts")]);
    const handler = docmosisLoadHandler({
      run: (cmd, argv, opts) => run(cmd, argv, { env: opts.env as NodeJS.ProcessEnv, timeoutMs: opts.timeoutMs, signal: opts.signal })
    });
    return await handler.run(args, context);
  }
};

/** `jira.attach-video`, its module loaded only when a job of it arrives, as `docmosis.load`'s is. */
const videoAttach: PodJobHandler = {
  kind: VIDEO_ATTACH_KIND,
  budgetMs: VIDEO_ATTACH_BUDGET_MS,
  run: async (args, context) => {
    const [{ videoAttachHandler }, { run }, { atlassianLogin }] = await Promise.all([
      import("./video-attach.ts"),
      import("../virtual/process.ts"),
      import("../virtual/atlassian.ts")
    ]);
    const handler = videoAttachHandler({
      run: (cmd, argv, opts) => run(cmd, argv, { env: opts.env as NodeJS.ProcessEnv, timeoutMs: opts.timeoutMs, signal: opts.signal }),
      login: ({ env }) => atlassianLogin({ env })
    });
    return await handler.run(args, context);
  }
};

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringArg(args: unknown, name: string, pattern: RegExp): string {
  const value = (args as Record<string, unknown> | null)?.[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`the job's ${name} is not one this client can run`);
  }
  return value;
}

/** A product's templates, read from Notify with its key from the product's AAT Key Vault. */
export const notifyList: PodJobHandler = {
  kind: "notify.list",
  // Under the hub's 120 seconds, and past the 60 the package gives `az`.
  budgetMs: 110_000,
  concurrency: 2,
  run: async (args) => {
    const product = stringArg(args, "product", SAFE_NAME_RE);
    const { listNotifyTemplates } = await loadNotify();
    return await listNotifyTemplates(product);
  }
};

/** One template loaded into the conversation as its Notify template's next version, through the agent API, as the owner's. */
export const notifyPull: PodJobHandler = {
  kind: "notify.pull",
  budgetMs: 140_000,
  run: async (args, { agentId, api, signal }) => {
    const product = stringArg(args, "product", SAFE_NAME_RE);
    const templateId = stringArg(args, "template_id", UUID_RE);
    if (agentId === undefined) {
      throw new PodJobError("no_session", "This chat has no assistant session yet. Send it a message, then try again.");
    }
    const { pullNotifyTemplate } = await loadNotify();
    const { version } = await pullNotifyTemplate({ productId: product, templateId, agentId, api, signal, by: "user" });
    return { version };
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
export const POD_JOB_HANDLERS: readonly PodJobHandler[] = [docmosisLoad, notifyList, notifyPull, videoAttach];
