-- Drops the conversation columns that `20261211090000_assistant_document` and `20261212090000_assistant_items` moved
-- off `assistant_conversation`, which no build reads or writes any longer:
--
--   * `artefact_*`, `jira_*`, `confluence_*` and `github_*`, now in `assistant_document`;
--   * `deck_*`, `docmosis_*` and `notify_*`, now in `assistant_deck`, `assistant_docmosis` and `assistant_notify`.
--
-- The CHECK constraints on these columns and the pending-export partial indexes go with them: each names only
-- columns dropped here.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_conversation"
  DROP COLUMN IF EXISTS "artefact_title",
  DROP COLUMN IF EXISTS "artefact_markdown",
  DROP COLUMN IF EXISTS "artefact_version",
  DROP COLUMN IF EXISTS "artefact_updated_by",
  DROP COLUMN IF EXISTS "artefact_updated_at",
  DROP COLUMN IF EXISTS "deck_version",
  DROP COLUMN IF EXISTS "deck_title",
  DROP COLUMN IF EXISTS "deck_updated_by",
  DROP COLUMN IF EXISTS "deck_updated_at",
  DROP COLUMN IF EXISTS "deck_revision",
  DROP COLUMN IF EXISTS "docmosis_version",
  DROP COLUMN IF EXISTS "docmosis_revision",
  DROP COLUMN IF EXISTS "docmosis_name",
  DROP COLUMN IF EXISTS "docmosis_updated_by",
  DROP COLUMN IF EXISTS "docmosis_updated_at",
  DROP COLUMN IF EXISTS "docmosis_pdf_state",
  DROP COLUMN IF EXISTS "notify_version",
  DROP COLUMN IF EXISTS "notify_revision",
  DROP COLUMN IF EXISTS "notify_name",
  DROP COLUMN IF EXISTS "notify_updated_by",
  DROP COLUMN IF EXISTS "notify_updated_at",
  DROP COLUMN IF EXISTS "jira_export_id",
  DROP COLUMN IF EXISTS "jira_project",
  DROP COLUMN IF EXISTS "jira_status",
  DROP COLUMN IF EXISTS "jira_key",
  DROP COLUMN IF EXISTS "jira_error",
  DROP COLUMN IF EXISTS "jira_requested_at",
  DROP COLUMN IF EXISTS "jira_exported_at",
  DROP COLUMN IF EXISTS "confluence_export_id",
  DROP COLUMN IF EXISTS "confluence_space_id",
  DROP COLUMN IF EXISTS "confluence_space_key",
  DROP COLUMN IF EXISTS "confluence_space_name",
  DROP COLUMN IF EXISTS "confluence_parent_id",
  DROP COLUMN IF EXISTS "confluence_parent_title",
  DROP COLUMN IF EXISTS "confluence_status",
  DROP COLUMN IF EXISTS "confluence_page_id",
  DROP COLUMN IF EXISTS "confluence_page_title",
  DROP COLUMN IF EXISTS "confluence_error",
  DROP COLUMN IF EXISTS "confluence_requested_at",
  DROP COLUMN IF EXISTS "confluence_exported_at",
  DROP COLUMN IF EXISTS "github_export_id",
  DROP COLUMN IF EXISTS "github_repo",
  DROP COLUMN IF EXISTS "github_status",
  DROP COLUMN IF EXISTS "github_number",
  DROP COLUMN IF EXISTS "github_error",
  DROP COLUMN IF EXISTS "github_requested_at",
  DROP COLUMN IF EXISTS "github_project_owner",
  DROP COLUMN IF EXISTS "github_project_number",
  DROP COLUMN IF EXISTS "github_project_title",
  DROP COLUMN IF EXISTS "github_project_error";
