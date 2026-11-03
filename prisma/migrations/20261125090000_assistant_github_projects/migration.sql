-- An issue lives in a repository; a GitHub Project is a board that shows issues from any number of them. So beside the
-- repository a person may pick a Project of its owner's, which the pod adds the issue to once it exists. Adding it can
-- fail while the issue stands, so that failure is kept apart from the export's own.
--
-- The person's default Project sits beside their default repository. Repositories and Projects are found by the same
-- lookups as Jira projects and Confluence pages, run by the pod with gh; a Project lookup names the owner whose
-- Projects to search.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_conversation"
  ADD COLUMN "github_project_owner"  TEXT    CHECK ("github_project_owner" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  ADD COLUMN "github_project_number" INTEGER CHECK ("github_project_number" > 0),
  ADD COLUMN "github_project_title"  TEXT    CHECK (char_length("github_project_title") <= 200),
  ADD COLUMN "github_project_error"  TEXT    CHECK (char_length("github_project_error") <= 300),
  -- A Project is its owner, number and title together, or none of them.
  ADD CONSTRAINT "assistant_conversation_github_project_check" CHECK (
    ("github_project_owner" IS NULL) = ("github_project_number" IS NULL) AND ("github_project_owner" IS NULL) = ("github_project_title" IS NULL)
  );

ALTER TABLE "assistant_export_default"
  ADD COLUMN "github_project_owner"  TEXT    CHECK ("github_project_owner" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  ADD COLUMN "github_project_number" INTEGER CHECK ("github_project_number" > 0),
  ADD COLUMN "github_project_title"  TEXT    CHECK (char_length("github_project_title") <= 200),
  ADD CONSTRAINT "assistant_export_default_github_project_check" CHECK (
    ("github_project_owner" IS NULL) = ("github_project_number" IS NULL) AND ("github_project_owner" IS NULL) = ("github_project_title" IS NULL)
  );

ALTER TABLE "assistant_lookup"
  DROP CONSTRAINT "assistant_lookup_kind_check",
  ADD CONSTRAINT "assistant_lookup_kind_check" CHECK ("kind" IN ('jira_project', 'confluence_page', 'github_repo', 'github_project')),
  ADD COLUMN "github_owner" TEXT CHECK ("github_owner" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$');
