-- A conversation's document exported to a GitHub repository as an issue, once, for a person whose ticket tool is
-- GitHub rather than Jira. The pod creates the issue with its owner's gh sign-in and reports its number; the export
-- id lets a repeated or late report be told apart from the current export, as it does for Jira.
--
-- The person's ticket tool and default repository sit beside their other export defaults. Every existing row, and
-- every person with none, keeps Jira.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_conversation"
  ADD COLUMN "github_export_id"    UUID,
  ADD COLUMN "github_repo"         TEXT        CHECK ("github_repo" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$'),
  ADD COLUMN "github_status"       TEXT        CHECK ("github_status" IN ('pending', 'done', 'failed')),
  ADD COLUMN "github_number"       INTEGER     CHECK ("github_number" > 0),
  ADD COLUMN "github_error"        TEXT        CHECK (char_length("github_error") <= 300),
  ADD COLUMN "github_requested_at" TIMESTAMPTZ,
  ADD CONSTRAINT "assistant_conversation_github_done_check" CHECK ("github_status" IS DISTINCT FROM 'done' OR "github_number" IS NOT NULL);

ALTER TABLE "assistant_export_default"
  ADD COLUMN "ticket_tool" TEXT NOT NULL DEFAULT 'jira' CHECK ("ticket_tool" IN ('jira', 'github')),
  ADD COLUMN "github_repo" TEXT CHECK ("github_repo" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$');
