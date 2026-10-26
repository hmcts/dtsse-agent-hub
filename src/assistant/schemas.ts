import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";
import { MAX_DELETED_PER_FRAME, MAX_REPORTED_FILES } from "./upload-report.ts";

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

/** A Jira issue key and the longest error a pod may report for an export; the migration checks the same. */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-\d{1,9}$/;
export const MAX_JIRA_ERROR = 300;

export const jiraExportReportBody = z.union([
  z.object({ export_id: z.string().uuid(), key: z.string().regex(JIRA_KEY_RE) }).strict(),
  z.object({ export_id: z.string().uuid(), error: z.string().trim().min(1).max(MAX_JIRA_ERROR) }).strict()
]);

const wholeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * What the pod says its own volume holds, and which deletions it has carried out.
 *
 * Every figure is refused when it is not a whole non-negative count, because a wrong number shown as fact is worse
 * than none. `files` and `deleted` have to be **present arrays** for the same reason: leaving one out would read as
 * an authoritative empty list, and `deleted` empty is what tells the hub a deletion is still outstanding. Their
 * entries are read leniently in `readReportedFiles` and `readAcknowledged`, since one unreadable id must not lose a
 * whole report.
 */
export const uploadsReportBody = z.object({
  uploads_bytes: wholeCount,
  volume_used_bytes: wholeCount,
  volume_total_bytes: wholeCount,
  files_total: wholeCount,
  files: z.array(z.unknown()).max(MAX_REPORTED_FILES),
  deleted: z.array(z.unknown()).max(MAX_DELETED_PER_FRAME)
});
