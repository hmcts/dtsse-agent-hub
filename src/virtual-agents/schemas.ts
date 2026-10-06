import { z } from "zod";
import { POD_PHASES } from "./lifecycle.ts";

/** Request bodies of `/api/virtual/{id}/…` and `/api/orchestrator/…` in `docs/agent-api.md`. */

const MAX_DETAIL = 500;
const MAX_URI = 2048;
/** The longest a device-code login may wait: GitHub's codes last 15 minutes and Azure's about the same. */
export const MAX_LOGIN_SECONDS = 3600;

/** GitHub's `ABCD-1234`, Azure's `ABCDEFGHI`: letters, digits and hyphens. */
const USER_CODE = /^[A-Za-z0-9-]{1,64}$/;

const CLUSTER = /^[A-Za-z0-9._-]{1,100}$/;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value));

export const statusBody = z.object({
  phase: z.enum(POD_PHASES),
  detail: optionalText(MAX_DETAIL)
});

export const credentialValueBody = z.object({ value: z.string() });

/**
 * Only an `https` URL is shown to the owner as a link: anything else, a `javascript:` URL above all, could act in
 * the hub's own origin when clicked.
 */
const httpsUrl = z
  .string()
  .trim()
  .max(MAX_URI)
  .url()
  .refine((value) => new URL(value).protocol === "https:", "must be an https URL");

export const loginBody = z
  .object({
    prompt: z.enum(["device_code", "paste_code"]),
    verification_uri: httpsUrl,
    user_code: z.string().trim().regex(USER_CODE, "must be letters, digits and hyphens").nullish(),
    expires_in: z.number().int().min(1).max(MAX_LOGIN_SECONDS)
  })
  .refine((value) => value.prompt !== "device_code" || (value.user_code ?? null) !== null, {
    message: "a device_code login needs a user_code",
    path: ["user_code"]
  });

export const completeBody = z.object({
  account_oid: optionalText(200),
  account_label: optionalText(200)
});

export const claimBody = z.object({ cluster: z.string().trim().regex(CLUSTER, "must be 1–100 letters, digits, dots, hyphens or underscores") });

export const observedBody = z.object({
  generation: z.number().int().min(0),
  replicas_ready: z.number().int().min(0).max(10),
  pod_phase: optionalText(64),
  reason: optionalText(200),
  disk_deleted: z.boolean().optional()
});

export const applyFailedBody = z.object({
  generation: z.number().int().min(0),
  error: z.string().trim().min(1).max(MAX_DETAIL)
});
