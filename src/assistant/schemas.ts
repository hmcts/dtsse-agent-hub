import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";

/** Request bodies of the Assistant mode section of `docs/agent-api.md`, and the limits the web UI shares. */

export const MAX_ARTEFACT_MARKDOWN = 100_000;
export const MAX_ARTEFACT_TITLE = 200;
export const MAX_SESSION_DETAIL = 200;
export const MAX_SESSIONS_REPORTED = 50;
export const MAX_SESSIONS_AT_ONCE = 20;

export const artefactTitle = z.string().trim().min(1).max(MAX_ARTEFACT_TITLE);

export const artefactPutBody = z.object({
  title: artefactTitle.nullish(),
  markdown: z.string().max(MAX_ARTEFACT_MARKDOWN),
  base_version: z.number().int().nonnegative()
});

export const sessionsReportBody = z.object({
  sessions: boundedArray(
    z.object({
      conversation_id: z.string().min(1).max(64),
      state: z.enum(["starting", "live", "queued"]),
      detail: z.string().max(MAX_SESSION_DETAIL).nullish()
    }),
    MAX_SESSIONS_REPORTED
  ),
  max: z.number().int().min(1).max(MAX_SESSIONS_AT_ONCE)
});

export type SessionsReport = z.infer<typeof sessionsReportBody>;

/**
 * What the pod says its own volume holds. The figures are refused when they are not whole non-negative byte counts,
 * because a wrong number shown as fact is worse than none; the `files` list is read leniently in
 * `readReportedFiles`, since the totals are what the person is told and one unreadable entry must not lose them.
 */
export const uploadsReportBody = z.object({
  uploads_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  volume_used_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  volume_total_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  files: z.unknown().nullish()
});
