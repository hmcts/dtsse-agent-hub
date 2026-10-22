import { z } from "zod";

/** Request bodies of the Assistant mode section of `docs/agent-api.md`, and the limits the web UI shares. */

export const MAX_ARTEFACT_MARKDOWN = 100_000;
export const MAX_ARTEFACT_TITLE = 200;
export const MAX_CONVERSATION_TITLE = 200;
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
  sessions: z
    .array(
      z.object({
        conversation_id: z.string().min(1).max(64),
        state: z.enum(["starting", "live", "queued"]),
        detail: z.string().max(MAX_SESSION_DETAIL).nullish()
      })
    )
    .max(MAX_SESSIONS_REPORTED),
  max: z.number().int().min(1).max(MAX_SESSIONS_AT_ONCE)
});

export type SessionsReport = z.infer<typeof sessionsReportBody>;
