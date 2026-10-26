-- A conversation's document exported to a Jira backlog, once. The pod creates the issue with its owner's twg
-- sign-in and reports the key; the export id lets a repeated or late report be told apart from the current export.
ALTER TABLE "assistant_conversation"
  ADD COLUMN "jira_export_id"    UUID,
  ADD COLUMN "jira_project"      TEXT        CHECK ("jira_project" ~ '^[A-Z][A-Z0-9_]{1,9}$'),
  ADD COLUMN "jira_status"       TEXT        CHECK ("jira_status" IN ('pending', 'done', 'failed')),
  ADD COLUMN "jira_key"          TEXT        CHECK ("jira_key" ~ '^[A-Z][A-Z0-9_]{1,9}-[0-9]{1,9}$'),
  ADD COLUMN "jira_error"        TEXT        CHECK (char_length("jira_error") <= 300),
  ADD COLUMN "jira_requested_at" TIMESTAMPTZ,
  ADD COLUMN "jira_exported_at"  TIMESTAMPTZ,
  ADD CONSTRAINT "assistant_conversation_jira_done_check" CHECK ("jira_status" IS DISTINCT FROM 'done' OR "jira_key" IS NOT NULL);

CREATE INDEX "assistant_conversation_jira_pending_idx" ON "assistant_conversation" ("virtual_agent_id", "jira_requested_at")
  WHERE "jira_status" = 'pending';
