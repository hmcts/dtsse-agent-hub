import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";
import {
  DEFAULT_RETENTION_DAYS,
  MAX_COMMENT,
  MAX_LINK_LABEL,
  MAX_LINKS_PER_PROJECT,
  MAX_MEMBERS,
  MAX_PAGE_PATH,
  MAX_PROJECT_NAME,
  MAX_PROTOTYPE_VERSION,
  MAX_RECORDING_MS,
  MAX_RETENTION_DAYS,
  MAX_SEGMENT_BYTES,
  MAX_SEGMENT_SEQ,
  MAX_TARGET_URL,
  MIN_RETENTION_DAYS
} from "./limits.ts";
import { allowPrivateTargets } from "./targets.ts";

/**
 * Request bodies of prototype feedback, for `parse` from `src/agent-api/http.ts`. On the wire in snake_case like the
 * rest of the API; each parses to the camelCase input its store function takes.
 */

const name = z.string().trim().min(1).max(MAX_PROJECT_NAME);
const prototypeVersion = z.string().trim().min(1).max(MAX_PROTOTYPE_VERSION);
const retentionDays = z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS);
const oid = z.string().trim().min(1).max(64);
const commentBody = z.string().trim().min(1).max(MAX_COMMENT);

/**
 * An https address with a host and no user name or password in it, which is all a link's target may be; http too
 * where `allowPrivateTargets` lets a developer point a link at their own machine.
 */
export const targetUrl = z
  .string()
  .trim()
  .max(MAX_TARGET_URL)
  .refine((value) => {
    if (!URL.canParse(value)) {
      return false;
    }
    const url = new URL(value);
    const scheme = url.protocol === "https:" || (url.protocol === "http:" && allowPrivateTargets());
    return scheme && url.hostname !== "" && url.username === "" && url.password === "";
  }, "must be an https address");

// Control characters would end up in a stored path the pages render and the proxy requests.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what this refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A page of the prototype as the widget saw it: its path and query, root-relative to the link's target. */
export const pagePath = z
  .string()
  .min(1)
  .max(MAX_PAGE_PATH)
  .refine((value) => value.startsWith("/") && !value.startsWith("//") && !CONTROL.test(value), "must be a path starting with /");

const finite = z.number().finite();
const extent = z.number().finite().min(0);

/** How the widget found the element a thread is pinned to, and where it was on a viewport of what size. */
export const feedbackAnchor = z.strictObject({
  selector: z.string().min(1).max(1000),
  text: z.string().max(500),
  tag: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  rect: z.strictObject({ x: finite, y: finite, width: extent, height: extent }),
  viewport: z.strictObject({ width: z.number().int().min(1).max(20_000), height: z.number().int().min(1).max(20_000) })
});

export type FeedbackAnchor = z.infer<typeof feedbackAnchor>;

export const feedbackLinkBody = z
  .strictObject({ label: z.string().trim().min(1).max(MAX_LINK_LABEL), url: targetUrl, prototype_version: prototypeVersion.optional() })
  .transform(({ label, url, prototype_version }) => ({ label, targetUrl: url, prototypeVersion: prototype_version ?? null }));

export type FeedbackLinkInput = z.output<typeof feedbackLinkBody>;

const memberOids = boundedArray(oid, MAX_MEMBERS, { message: `at most ${MAX_MEMBERS} people` });

export const createFeedbackProjectBody = z
  .strictObject({
    name,
    links: boundedArray(feedbackLinkBody, MAX_LINKS_PER_PROJECT, { min: 1, message: `at most ${MAX_LINKS_PER_PROJECT} links` }),
    member_oids: memberOids.optional(),
    mask_inputs: z.boolean().optional(),
    retention_days: retentionDays.optional()
  })
  .transform((body) => ({
    name: body.name,
    links: body.links,
    memberOids: body.member_oids ?? [],
    maskInputs: body.mask_inputs ?? false,
    retentionDays: body.retention_days ?? DEFAULT_RETENTION_DAYS
  }));

export type CreateFeedbackProjectInput = z.output<typeof createFeedbackProjectBody>;

export const feedbackMembersBody = z.strictObject({ member_oids: memberOids }).transform((body) => ({ memberOids: body.member_oids }));

export const feedbackSettingsBody = z
  .strictObject({ name: name.optional(), mask_inputs: z.boolean().optional(), retention_days: retentionDays.optional() })
  .refine((body) => body.name !== undefined || body.mask_inputs !== undefined || body.retention_days !== undefined, "nothing to change")
  .transform((body) => ({ name: body.name, maskInputs: body.mask_inputs, retentionDays: body.retention_days }));

export type FeedbackSettingsInput = z.output<typeof feedbackSettingsBody>;

const offsetMs = z.number().int().min(0).max(MAX_RECORDING_MS);

export const createFeedbackThreadBody = z
  .strictObject({
    page_path: pagePath,
    anchor: feedbackAnchor,
    body: commentBody,
    // Whether the widget will upload the page's snapshot, so the thread is given a place for it.
    snapshot: z.boolean().optional(),
    recording_id: z.uuid().optional(),
    offset_ms: offsetMs.optional()
  })
  .refine((body) => (body.recording_id === undefined) === (body.offset_ms === undefined), "recording_id and offset_ms go together")
  .transform((body) => ({
    pagePath: body.page_path,
    anchor: body.anchor,
    body: body.body,
    snapshot: body.snapshot ?? false,
    recordingId: body.recording_id ?? null,
    offsetMs: body.offset_ms ?? null
  }));

export type CreateFeedbackThreadInput = z.output<typeof createFeedbackThreadBody>;

export const feedbackReplyBody = z.strictObject({ body: commentBody });

/** A status change, or a re-anchor, which puts a detached thread back on the page as open. */
export const patchFeedbackThreadBody = z.union([
  z.strictObject({ status: z.enum(["open", "resolved", "detached"]) }),
  z.strictObject({ anchor: feedbackAnchor, page_path: pagePath.optional() }).transform((body) => ({ anchor: body.anchor, pagePath: body.page_path }))
]);

export type PatchFeedbackThreadInput = z.output<typeof patchFeedbackThreadBody>;

export const startFeedbackRecordingBody = z.strictObject({});

export const feedbackUploadBody = z
  .strictObject({
    kind: z.enum(["audio", "replay"]),
    seq: z.number().int().min(0).max(MAX_SEGMENT_SEQ),
    page_path: pagePath.optional(),
    offset_ms: offsetMs,
    bytes: z.number().int().min(1).max(MAX_SEGMENT_BYTES)
  })
  .transform((body) => ({ kind: body.kind, seq: body.seq, pagePath: body.page_path ?? null, offsetMs: body.offset_ms, bytes: body.bytes }));

export type FeedbackUploadInput = z.output<typeof feedbackUploadBody>;

export const completeFeedbackRecordingBody = z.strictObject({ duration_ms: offsetMs }).transform((body) => ({ durationMs: body.duration_ms }));
