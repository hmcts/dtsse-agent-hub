-- Where a person's documents go by default: a Jira project and a Confluence parent page, each optional, which the
-- document panel starts from and the person can change for one document there. One row per person.
--
-- The names and titles are kept beside the ids so the settings and the panel can show the choice without searching
-- Atlassian again. They are what the person picked from their own search, so they can go stale when a page is renamed;
-- an export uses only the ids.
CREATE TABLE "assistant_export_default" (
  "owner_oid"               TEXT        NOT NULL PRIMARY KEY REFERENCES "user" ("oid") ON DELETE CASCADE,
  "jira_project"            TEXT        CHECK ("jira_project" ~ '^[A-Z][A-Z0-9_]{1,9}$'),
  "jira_project_name"       TEXT        CHECK (char_length("jira_project_name") <= 200),
  "confluence_parent_id"    TEXT        CHECK ("confluence_parent_id" ~ '^[0-9]{1,20}$'),
  "confluence_parent_title" TEXT        CHECK (char_length("confluence_parent_title") <= 255),
  "confluence_space_id"     TEXT        CHECK ("confluence_space_id" ~ '^[0-9]{1,20}$'),
  "confluence_space_key"    TEXT        CHECK ("confluence_space_key" ~ '^~?[A-Za-z0-9_-]{1,100}$'),
  "confluence_space_name"   TEXT        CHECK (char_length("confluence_space_name") <= 200),
  -- The titles above the parent page, from the space's top, as a JSON array of at most 8 strings.
  "confluence_ancestors"    JSONB       NOT NULL DEFAULT '[]',
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A page is its id, its space and its title together, or none of them.
  CONSTRAINT "assistant_export_default_confluence_check" CHECK (
    ("confluence_parent_id" IS NULL) = ("confluence_space_id" IS NULL)
    AND ("confluence_parent_id" IS NULL) = ("confluence_space_key" IS NULL)
    AND ("confluence_parent_id" IS NULL) = ("confluence_parent_title" IS NULL)
  )
);
