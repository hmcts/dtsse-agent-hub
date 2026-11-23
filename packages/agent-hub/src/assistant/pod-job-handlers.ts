import { DOCMOSIS_LOAD_KIND, LOAD_BUDGET_MS } from "./docmosis-load-kind.ts";
import type { Run } from "./lookups.ts";
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
    const [{ docmosisLoadHandler }, run] = await Promise.all([import("./docmosis-load.ts"), runner()]);
    const handler = docmosisLoadHandler({ run });
    return await handler.run(args, context);
  }
};

/** `jira.attach-video`, its module loaded only when a job of it arrives, as `docmosis.load`'s is. */
const videoAttach: PodJobHandler = {
  kind: VIDEO_ATTACH_KIND,
  budgetMs: VIDEO_ATTACH_BUDGET_MS,
  run: async (args, context) => {
    const [{ videoAttachHandler }, run, { atlassianLogin }] = await Promise.all([import("./video-attach.ts"), runner(), import("../virtual/atlassian.ts")]);
    const handler = videoAttachHandler({ run, login: ({ env }) => atlassianLogin({ env }) });
    return await handler.run(args, context);
  }
};

/** The command runner the handlers that run programs share, its module loaded only when a job arrives. */
async function runner(): Promise<Run> {
  const { run } = await import("../virtual/process.ts");
  return (cmd, argv, opts) => run(cmd, argv, { env: opts.env as NodeJS.ProcessEnv, timeoutMs: opts.timeoutMs, signal: opts.signal });
}

/** The case types the owner's workspace declares. */
export const ccdCaseTypes: PodJobHandler = {
  kind: "ccd.case-types",
  // Under the hub's 60 seconds.
  budgetMs: 50_000,
  concurrency: 2,
  run: async (args, context) => (await import("./ccd-case-types.ts")).listCaseTypes(args, context, { run: await runner() })
};

/** One case type's fields; a config-generator service's definition may be generated first. */
export const ccdCaseTypeFields: PodJobHandler = {
  kind: "ccd.case-type-fields",
  // Under the hub's 180 seconds, past the 160 the script is given.
  budgetMs: 170_000,
  // One at a time: two generations of one repository's definition would run Gradle twice in the same clone.
  concurrency: 1,
  run: async (args, context) => (await import("./ccd-case-types.ts")).caseTypeFields(args, context, { run: await runner() })
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

/**
 * One template loaded into the conversation, through the agent API, as the owner's: as the next version of the Notify
 * template `item_id`, or, without it, as a new one.
 */
export const notifyPull: PodJobHandler = {
  kind: "notify.pull",
  budgetMs: 140_000,
  run: async (args, { agentId, api, signal, jobId }) => {
    const product = stringArg(args, "product", SAFE_NAME_RE);
    const templateId = stringArg(args, "template_id", UUID_RE);
    const target = (args as Record<string, unknown>).item_id === undefined ? undefined : stringArg(args, "item_id", UUID_RE);
    if (agentId === undefined) {
      throw new PodJobError("no_session", "This chat has no assistant session yet. Send it a message, then try again.");
    }
    const { pullNotifyTemplate } = await loadNotify();
    // A job naming no item is the picker's new template, which is made even where another holds the Notify template.
    const { id, version } = await pullNotifyTemplate({
      productId: product,
      templateId,
      agentId,
      target,
      api,
      signal,
      by: "user",
      create: target === undefined,
      jobId
    });
    return { version, item_id: id };
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
export const POD_JOB_HANDLERS: readonly PodJobHandler[] = [docmosisLoad, notifyList, notifyPull, videoAttach, ccdCaseTypes, ccdCaseTypeFields];
