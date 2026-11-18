-- A conversation's documents, any number of them, each of one kind: `document`, which can go to a ticket and to
-- Confluence; `ticket`, a Jira backlog item or a GitHub issue, which goes only to the person's ticket tool; and
-- `confluence`, which goes only to Confluence. Each document carries its own exports, with the checks the
-- conversation's export columns had. The conversation's primary document is its oldest of kind `document`, which is
-- what `/api/agent/{id}/artefact` and an older client read. See src/assistant/artefact-store.ts.
--
-- Every conversation with a document or any export state gets one `document` row carrying it, export ids included,
-- so a pod's report of an export claimed before this migration still finds its document.
--
-- The conversation's `artefact_*`, `jira_*`, `github_*` and `confluence_*` columns stay, unread, for the previous
-- build serving beside this one, whose client names them; prisma/schema.prisma marks them `@ignore`, and a later
-- migration drops them.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "assistant_document" (
  "id"                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id"         UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "kind"                    TEXT        NOT NULL CHECK ("kind" IN ('document', 'ticket', 'confluence')),
  "title"                   TEXT        CHECK (char_length("title") BETWEEN 1 AND 200),
  "markdown"                TEXT        NOT NULL DEFAULT '' CHECK (char_length("markdown") <= 100000),
  "version"                 INTEGER     NOT NULL DEFAULT 0 CHECK ("version" >= 0),
  "updated_by"              TEXT        CHECK ("updated_by" IN ('user', 'agent')),
  "updated_at"              TIMESTAMPTZ,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "jira_export_id"          UUID,
  "jira_project"            TEXT        CHECK ("jira_project" ~ '^[A-Z][A-Z0-9_]{1,9}$'),
  "jira_status"             TEXT        CHECK ("jira_status" IN ('pending', 'done', 'failed')),
  "jira_key"                TEXT        CHECK ("jira_key" ~ '^[A-Z][A-Z0-9_]{1,9}-[0-9]{1,9}$'),
  "jira_error"              TEXT        CHECK (char_length("jira_error") <= 300),
  "jira_requested_at"       TIMESTAMPTZ,
  "github_export_id"        UUID,
  "github_repo"             TEXT        CHECK ("github_repo" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$' AND "github_repo" !~ '/\.\.?$'),
  "github_status"           TEXT        CHECK ("github_status" IN ('pending', 'done', 'failed')),
  "github_number"           INTEGER     CHECK ("github_number" > 0),
  "github_error"            TEXT        CHECK (char_length("github_error") <= 300),
  "github_requested_at"     TIMESTAMPTZ,
  "github_project_owner"    TEXT        CHECK ("github_project_owner" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  "github_project_number"   INTEGER     CHECK ("github_project_number" > 0),
  "github_project_title"    TEXT        CHECK (char_length("github_project_title") <= 200),
  "github_project_error"    TEXT        CHECK (char_length("github_project_error") <= 300),
  "confluence_export_id"    UUID,
  "confluence_space_id"     TEXT        CHECK ("confluence_space_id" ~ '^[0-9]{1,20}$'),
  "confluence_space_key"    TEXT        CHECK ("confluence_space_key" ~ '^~?[A-Za-z0-9_-]{1,100}$'),
  "confluence_space_name"   TEXT        CHECK (char_length("confluence_space_name") <= 200),
  "confluence_parent_id"    TEXT        CHECK ("confluence_parent_id" ~ '^[0-9]{1,20}$'),
  "confluence_parent_title" TEXT        CHECK (char_length("confluence_parent_title") <= 255),
  "confluence_status"       TEXT        CHECK ("confluence_status" IN ('pending', 'done', 'failed')),
  "confluence_page_id"      TEXT        CHECK ("confluence_page_id" ~ '^[0-9]{1,20}$'),
  "confluence_page_title"   TEXT        CHECK (char_length("confluence_page_title") <= 255),
  "confluence_error"        TEXT        CHECK (char_length("confluence_error") <= 300),
  "confluence_requested_at" TIMESTAMPTZ,
  CONSTRAINT "assistant_document_jira_done_check" CHECK ("jira_status" IS DISTINCT FROM 'done' OR "jira_key" IS NOT NULL),
  CONSTRAINT "assistant_document_github_done_check" CHECK ("github_status" IS DISTINCT FROM 'done' OR "github_number" IS NOT NULL),
  -- A Project is its owner, number and title together, or none of them.
  CONSTRAINT "assistant_document_github_project_check" CHECK (
    ("github_project_owner" IS NULL) = ("github_project_number" IS NULL) AND ("github_project_owner" IS NULL) = ("github_project_title" IS NULL)
  ),
  CONSTRAINT "assistant_document_confluence_done_check"
    CHECK ("confluence_status" IS DISTINCT FROM 'done' OR "confluence_page_id" IS NOT NULL)
);

-- The list, oldest first, which is also how the primary document is found.
CREATE INDEX "assistant_document_conversation_idx" ON "assistant_document" ("conversation_id", "created_at");

-- The frame reads a conversation's pending exports with every message.
CREATE INDEX "assistant_document_jira_pending_idx" ON "assistant_document" ("conversation_id", "jira_requested_at")
  WHERE "jira_status" = 'pending';
CREATE INDEX "assistant_document_github_pending_idx" ON "assistant_document" ("conversation_id", "github_requested_at")
  WHERE "github_status" = 'pending';
CREATE INDEX "assistant_document_confluence_pending_idx" ON "assistant_document" ("conversation_id", "confluence_requested_at")
  WHERE "confluence_status" = 'pending';

INSERT INTO "assistant_document" (
  "conversation_id", "kind", "title", "markdown", "version", "updated_by", "updated_at", "created_at",
  "jira_export_id", "jira_project", "jira_status", "jira_key", "jira_error", "jira_requested_at",
  "github_export_id", "github_repo", "github_status", "github_number", "github_error", "github_requested_at",
  "github_project_owner", "github_project_number", "github_project_title", "github_project_error",
  "confluence_export_id", "confluence_space_id", "confluence_space_key", "confluence_space_name", "confluence_parent_id",
  "confluence_parent_title", "confluence_status", "confluence_page_id", "confluence_page_title", "confluence_error",
  "confluence_requested_at"
)
SELECT "id", 'document', "artefact_title", "artefact_markdown", "artefact_version", "artefact_updated_by", "artefact_updated_at", "created_at",
       "jira_export_id", "jira_project", "jira_status", "jira_key", "jira_error", "jira_requested_at",
       "github_export_id", "github_repo", "github_status", "github_number", "github_error", "github_requested_at",
       "github_project_owner", "github_project_number", "github_project_title", "github_project_error",
       "confluence_export_id", "confluence_space_id", "confluence_space_key", "confluence_space_name", "confluence_parent_id",
       "confluence_parent_title", "confluence_status", "confluence_page_id", "confluence_page_title", "confluence_error",
       "confluence_requested_at"
  FROM "assistant_conversation"
 WHERE "artefact_version" > 0
    OR "jira_export_id" IS NOT NULL OR "jira_status" IS NOT NULL
    OR "github_export_id" IS NOT NULL OR "github_status" IS NOT NULL
    OR "confluence_export_id" IS NOT NULL OR "confluence_status" IS NOT NULL;
