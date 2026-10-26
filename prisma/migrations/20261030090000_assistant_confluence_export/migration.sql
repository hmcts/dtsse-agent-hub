-- A conversation's document published to Confluence once, as a new page under a parent page its owner picked. The
-- pod creates the page with its owner's twg sign-in and reports the page's id; the export id lets a repeated or late
-- report be told apart from the current export. The space key is kept so the hub builds the page's link itself, and
-- the titles so the panel can say where the page went without asking Confluence again.
ALTER TABLE "assistant_conversation"
  ADD COLUMN "confluence_export_id"    UUID,
  ADD COLUMN "confluence_space_id"     TEXT        CHECK ("confluence_space_id" ~ '^[0-9]{1,20}$'),
  ADD COLUMN "confluence_space_key"    TEXT        CHECK ("confluence_space_key" ~ '^~?[A-Za-z0-9_-]{1,100}$'),
  ADD COLUMN "confluence_space_name"   TEXT        CHECK (char_length("confluence_space_name") <= 200),
  ADD COLUMN "confluence_parent_id"    TEXT        CHECK ("confluence_parent_id" ~ '^[0-9]{1,20}$'),
  ADD COLUMN "confluence_parent_title" TEXT        CHECK (char_length("confluence_parent_title") <= 255),
  ADD COLUMN "confluence_status"       TEXT        CHECK ("confluence_status" IN ('pending', 'done', 'failed')),
  ADD COLUMN "confluence_page_id"      TEXT        CHECK ("confluence_page_id" ~ '^[0-9]{1,20}$'),
  -- The title the page was created with, which can differ from the document title when Confluence had one of that name.
  ADD COLUMN "confluence_page_title"   TEXT        CHECK (char_length("confluence_page_title") <= 255),
  ADD COLUMN "confluence_error"        TEXT        CHECK (char_length("confluence_error") <= 300),
  ADD COLUMN "confluence_requested_at" TIMESTAMPTZ,
  ADD COLUMN "confluence_exported_at"  TIMESTAMPTZ,
  ADD CONSTRAINT "assistant_conversation_confluence_done_check"
    CHECK ("confluence_status" IS DISTINCT FROM 'done' OR "confluence_page_id" IS NOT NULL);

CREATE INDEX "assistant_conversation_confluence_pending_idx" ON "assistant_conversation" ("virtual_agent_id", "confluence_requested_at")
  WHERE "confluence_status" = 'pending';
