import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";
import { MAX_NOTIFY_NAME, NOTIFY_TYPES, notifyId, notifyProduct } from "./notify.ts";
import { definePodJobKind } from "./pod-jobs.ts";

/**
 * The Notify panel's two pod jobs: listing a product's templates and loading one into the conversation. Both run on the
 * conversation's own pod, which reads the product's Notify key from its AAT Key Vault with the owner's own `az login`
 * and calls Notify with it; the key never leaves the pod. See "Notify templates" in docs/agent-api.md.
 */

/** The most templates a list answers with; a service with more says so with `truncated`. */
export const MAX_LISTED_TEMPLATES = 1000;

/**
 * Codes the panel words for the person. The pod's `detail` beside each is the package's own words: which vault, which
 * secret, what Notify said.
 */
export const NOTIFY_JOB_ERRORS = [
  "unknown_product",
  "az_missing",
  "az_login",
  "forbidden",
  "secret_not_found",
  "keyvault_error",
  "bad_key",
  "notify_forbidden",
  "not_found",
  "notify_error",
  "no_session",
  "conflict",
  "too_large",
  "tools_missing"
] as const;

export type NotifyJobError = (typeof NOTIFY_JOB_ERRORS)[number];

export const NOTIFY_LIST = definePodJobKind({
  kind: "notify.list",
  args: z.strictObject({ product: notifyProduct }),
  result: z.strictObject({
    templates: boundedArray(
      z.strictObject({
        id: notifyId,
        name: z.string().max(MAX_NOTIFY_NAME),
        type: z.enum(NOTIFY_TYPES),
        version: z.number().int().min(1)
      }),
      MAX_LISTED_TEMPLATES,
      { message: `at most ${MAX_LISTED_TEMPLATES} templates` }
    ),
    truncated: z.boolean()
  }),
  errors: NOTIFY_JOB_ERRORS,
  // Inside it: `az keyvault secret show`, which the package gives 60 seconds, and one Notify call.
  timeoutMs: 120_000,
  rateLimit: { limit: 30, windowMs: 60_000 },
  maxResultBytes: 1024 * 1024
});

export const NOTIFY_PULL = definePodJobKind({
  kind: "notify.pull",
  args: z.strictObject({ product: notifyProduct, template_id: notifyId }),
  result: z.strictObject({ version: z.number().int().min(1) }),
  errors: NOTIFY_JOB_ERRORS,
  // The Key Vault read, two Notify calls and the agent-path write of the version.
  timeoutMs: 150_000,
  rateLimit: { limit: 20, windowMs: 60_000 },
  // Two loads at once in one chat would race for the same next version; the second asks again once the first ends.
  oneAtATime: true,
  maxResultBytes: 1024
});
